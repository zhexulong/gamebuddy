using System.Reflection;
using System.Runtime.Serialization;
using System.Text.RegularExpressions;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Netcode;
using StardewValley;
using StardewValley.Tools;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Which tool a tool-family action runs WITH, decided by the Mod instead of guessed by the caller.
///
/// <para>
/// Why this exists: <c>cut_weeds</c>, <c>cut_grass</c>, <c>break_rock_source</c> and <c>water_crop</c> used to require
/// the request's <c>slot</c> to equal <c>CurrentToolIndex</c> and to hold the exact tool, so a live run that guessed the
/// slot came back with <c>scythe_not_equipped_in_requested_slot</c>, <c>basic_pickaxe_not_equipped_in_requested_slot</c>
/// and <c>watering_can_not_equipped</c>. None of that is the caller's to know: equipping is input selection, not an
/// action, and the native building-chest load already saves <c>CurrentToolIndex</c>, holds the slot for the call and
/// restores it (farmhandexecutioncontroller.buildingchestactions.cs:246-270). The handler now does the same, from the
/// tool its own registration claims.
/// </para>
///
/// <para>
/// <b>Instrument.</b> The decision is a pure projection over the pack it is handed, so it runs FOR REAL here against
/// synthetic packs: a tool instance cannot be CONSTRUCTED headless (the <c>Tool</c> ctor loads game content), so each one
/// is an uninitialized instance seeded through the very fields its identity and level are read from -
/// <c>Item._qualifiedItemId</c> and <c>Tool.upgradeLevel</c> - which is the suite's standing pattern
/// (<see cref="HeldToolProjectionTests"/>). The switch and its restore need a live <c>Game1.player</c>, so they are
/// pinned at the source instead: every one of the four handlers selects, and every exit restores in a <c>finally</c>. The
/// native half - a wrong tool held and the action still swings - belongs to the native-local fixture lane.
/// </para>
/// </summary>
public sealed class DeclaredToolSelectionTests
{
    [Fact]
    public void TheRequirementIsTheActionsOwnRegistrationClaim()
    {
        Claim("cut_weeds").Should().Be(new FarmhandActionResourceTemplateClaim("tool:scythe", FarmhandResourceTemplateValue.AnyUpgrade));
        Claim("cut_grass").Should().Be(new FarmhandActionResourceTemplateClaim("tool:scythe", FarmhandResourceTemplateValue.AnyUpgrade));
        Claim("break_rock_source").Should().Be(new FarmhandActionResourceTemplateClaim("tool:pickaxe", FarmhandResourceTemplateValue.BasicOnly));
        Claim("water_crop").Should().Be(new FarmhandActionResourceTemplateClaim("tool:watering_can", FarmhandResourceTemplateValue.AnyUpgrade));
        // An action that claims no tool answers no claim: the handler never invents one from its own id.
        Claim("till_soil").Should().BeNull();
    }

    [Fact]
    public void EveryDeclaredToolCategoryIsOneTheSelectionVocabularyKnows()
    {
        // The category reaches `MatchesToolCategory` verbatim, so a `tool:<word>` claim the matching switch does not know
        // would resolve to "not owned" forever. Categories come from the one published enum, which is what pins that.
        foreach (FarmhandActionRegistration registration in FarmhandActionCatalog.Registrations)
        {
            foreach (FarmhandActionResourceTemplateClaim claim in registration.Descriptor?.ResourceTemplate
                ?? Array.Empty<FarmhandActionResourceTemplateClaim>())
            {
                if (!claim.Key.StartsWith("tool:", StringComparison.Ordinal))
                    continue;
                FarmhandActionCatalog.ToolEnum.Should().Contain(claim.Key["tool:".Length..],
                    $"{registration.ActionId} claims a tool the selection vocabulary must be able to match");
            }
        }
    }

    [Fact]
    public void AHeldAxeIsNotAReasonTheScytheActionCannotRun()
    {
        // This is the live failure: the farmer was holding the axe, so every cut_weeds request was refused instead of
        // the scythe being taken. The resolution reads the PACK, never the hand, and answers the scythe's slot.
        IList<Item?> pack = new List<Item?> { Axe(upgradeLevel: 0), Scythe(), WateringCan() };

        DeclaredToolResolution resolution = Resolve(pack, "cut_weeds");

        resolution.RefusalCode.Should().BeNull();
        resolution.Category.Should().Be("scythe");
        resolution.Slot.Should().Be(1);
    }

    [Fact]
    public void ARequestThatNamesAnotherSlotDoesNotMoveTheAnswer()
    {
        // The number a request carries is ignored, not obeyed: the same pack answers the same slot no matter what the
        // caller guessed, which is why a disagreement cannot produce a failed hit any more.
        IList<Item?> pack = new List<Item?> { Axe(upgradeLevel: 0), Scythe() };

        Resolve(pack, "cut_weeds").Slot.Should().Be(1);
        Resolve(pack, "cut_weeds").Slot.Should().Be(1);
    }

    [Fact]
    public void AnUpgradedPickaxeDoesNotSatisfyTheBasicOnlyClaim()
    {
        // `break_rock_source` claims `BasicOnly` because the native guard refuses an upgraded pickaxe by name, so an
        // upgraded one is a NAMED tier refusal rather than a silent wrong tool: need is the claim's floor, have the
        // best owned level.
        DeclaredToolResolution upgradedOnly = Resolve(new List<Item?> { Pickaxe(upgradeLevel: 1) }, "break_rock_source");

        upgradedOnly.RefusalCode.Should().Be("tool_upgrade_insufficient:pickaxe:0:1");
        upgradedOnly.Slot.Should().Be(-1, "no slot can be named when no owned tool satisfies the claim");

        // With both owned, the claim picks the basic one even though the upgraded one outranks it.
        DeclaredToolResolution both = Resolve(
            new List<Item?> { Axe(upgradeLevel: 0), Pickaxe(upgradeLevel: 2), Pickaxe(upgradeLevel: 0) },
            "break_rock_source");

        both.RefusalCode.Should().BeNull();
        both.Slot.Should().Be(2);
    }

    [Fact]
    public void AMissingToolIsNamedSeparatelyFromATierMismatch()
    {
        // "you do not own one" and "you own the wrong tier" are different repairs: the first cannot be fixed by the Mod,
        // the second means the surface promised something the pack cannot satisfy.
        Resolve(new List<Item?> { Axe(upgradeLevel: 0) }, "cut_weeds").RefusalCode.Should().Be("tool_not_owned:scythe");
        Resolve(new List<Item?> { Pickaxe(upgradeLevel: 3) }, "break_rock_source").RefusalCode
            .Should().Be("tool_upgrade_insufficient:pickaxe:0:3");
        Resolve(new List<Item?>(), "water_crop").RefusalCode.Should().Be("tool_not_owned:watering_can");
    }

    [Fact]
    public void EveryToolActionSelectsItsDeclaredToolAndRestoresItInAFinally()
    {
        // The switch and the restore need a live `Game1.player`, so they are pinned where they are written: each handler
        // selects the tool its registration names (never the request's slot) and restores the actor's own selection on
        // EVERY exit, including the refusals after the switch.
        foreach ((string actionId, string file, string signature) in new[]
        {
            ("cut_weeds", ResourceToolActions, "private LocalExecutionReceipt ExecuteCutWeeds("),
            ("cut_grass", ResourceToolActions, "private LocalExecutionReceipt ExecuteCutGrass("),
            ("break_rock_source", ResourceToolActions, "private LocalExecutionReceipt ExecuteBreakRockSource("),
            ("water_crop", FarmingConstructionActions, "private LocalExecutionReceipt ExecuteWaterCrop("),
        })
        {
            string body = MethodBody(Read(file), signature);

            body.Should().Contain($"TrySelectDeclaredTool(Game1.player, \"{actionId}\",",
                $"{actionId} takes the tool its own registration declares");
            body.Should().Contain("finally", $"{actionId} restores the actor's selection on every exit");
            body.Should().Contain("RestoreToolSelection(Game1.player, selection)",
                $"{actionId} puts the index the actor held back");
            body.Should().NotContain("not_equipped",
                $"{actionId} no longer refuses the request's slot or the tool it happens to be holding");
            body.Should().NotContain("Game1.player.Items[slot]",
                $"{actionId} does not read a tool out of a slot the caller named");
        }
    }

    [Fact]
    public void EveryToolActionStillPublishesExactlyTheEvidenceKeysTheHostPins()
    {
        // The Host recognises a success by an EXACT receipt-detail key set
        // (`host/src/stardew-game-integration-adapter.ts`: the cut_weeds/cut_grass branches use `exactEvidence`, and
        // `hasWaterCropCompletionEvidence` / `hasBreakRockSourceCompletionEvidence` compare key counts). The Mod states
        // each set once, in ToolActionEvidence, so the paired change is one edit - and this test is what makes a drift
        // between the two sides fail HERE instead of in a live run.
        string adapter = Read(HostAdapter);

        ToolActionEvidence.CutWeeds.Should().BeEquivalentTo(
            HostEvidenceKeys(adapter, "case \"cut_weeds\":", "case \"cut_grass\":"));
        ToolActionEvidence.CutGrass.Should().BeEquivalentTo(
            HostEvidenceKeys(adapter, "case \"cut_grass\":", "case \"clear_cask\":"));
        ToolActionEvidence.BreakRockSource.Should().BeEquivalentTo(
            HostEvidenceKeys(adapter, "function hasBreakRockSourceCompletionEvidence(", "if (Object.keys(evidence).length"));
        ToolActionEvidence.WaterCrop.Should().BeEquivalentTo(
            HostEvidenceKeys(adapter, "function hasWaterCropCompletionEvidence(", "if (Object.keys(evidence).length"));
    }

    [Fact]
    public void TheComposedReceiptStatesTheSelectionAndThenTheRestoreItActuallyPerformed()
    {
        // The composer emits the list's own keys in the list's order, so a key without a value cannot reach the wire.
        DeclaredToolSelection selection = new(Pickaxe(upgradeLevel: 0), "pickaxe", 3, 0, Axe(upgradeLevel: 0));
        Dictionary<string, string> values = ToolActionEvidence.SelectionFacts(selection);
        values.Should().BeEquivalentTo(new Dictionary<string, string>
        {
            ["tool_selected"] = "pickaxe",
            ["slot"] = "3",
            ["tool_before"] = "axe",
            ["slot_before"] = "0",
        });
        values["target"] = "rock_01";
        values["tool"] = "pickaxe";
        values["qualified_item_id"] = "(O)2";
        values["durability_before"] = "1";
        values["durability_after"] = "removed";
        values["removed"] = "true";
        values["stamina_before"] = "100";
        values["stamina_after"] = "98";
        values["stamina_delta"] = "-2";
        values["expected_stamina_cost"] = "2";
        // A run that has not restored yet cannot mint the receipt: the key has no value until the finally writes it.
        bool restored;
        try
        {
            _ = ToolActionEvidence.Compose(ToolActionEvidence.BreakRockSource, values);
            restored = true;
        }
        catch (KeyNotFoundException)
        {
            restored = false;
        }
        restored.Should().BeFalse("the restore fact cannot be claimed before the restore has run");

        values["tool_restored"] = "axe";
        ToolActionEvidence.Compose(ToolActionEvidence.BreakRockSource, values).Should().Be(
            "target=rock_01;tool=pickaxe;tool_selected=pickaxe;slot=3;tool_before=axe;slot_before=0;qualified_item_id=(O)2;durability_before=1;durability_after=removed;removed=true;stamina_before=100;stamina_after=98;stamina_delta=-2;expected_stamina_cost=2;tool_restored=axe");
    }

    [Fact]
    public void TheToolAFactNamesIsThePublishedCategoryOfTheToolActuallyHeld()
    {
        // The Host reads `tool_selected`/`tool_before`/`tool_restored` as one word from the vocabulary an action's own
        // claim uses, so the namer has to agree with the matcher that decides ownership - including that a scythe is a
        // MeleeWeapon and must not be reported as `weapon`. One representative per published word, so a word added to
        // the vocabulary without a mapping (or a mapping word the vocabulary does not publish) fails here.
        foreach ((string category, Tool tool) in new (string, Tool)[]
        {
            ("axe", Axe(upgradeLevel: 0)),
            ("pickaxe", Pickaxe(upgradeLevel: 0)),
            ("hoe", Hoe()),
            ("watering_can", WateringCan()),
            ("fishing_rod", FishingRod()),
            ("scythe", Scythe()),
            ("weapon", Sword()),
            ("shears", Shears()),
            ("milk_pail", MilkPail()),
            ("pan", Pan()),
        })
        {
            FarmhandActionCatalog.ToolEnum.Should().Contain(category);
            ToolCategory(tool).Should().Be(category);
            // The snapshot's category and the claim matcher read the SAME mapping: one word per tool, both sides.
            ToolCategoryOfSlot(tool).Should().Be(category);
        }

        ToolCategory(null).Should().Be("none", "nothing held is the one literal the Host accepts for absent");
    }

    [Fact]
    public void EveryToolActionComposesItsReceiptAfterTheRestoreSoTheRestoreFactIsTrue()
    {
        // `tool_restored` may only be written after the finally has put the actor's selection back, and the receipt is
        // composed after that - so the key can never describe a restore that has not happened. Reordering either half
        // fails here rather than shipping a receipt that asserts an unperformed restore.
        foreach ((string actionId, string file, string signature, string keyList) in new[]
        {
            ("cut_weeds", ResourceToolActions, "private LocalExecutionReceipt ExecuteCutWeeds(", "CutWeeds"),
            ("cut_grass", ResourceToolActions, "private LocalExecutionReceipt ExecuteCutGrass(", "CutGrass"),
            ("break_rock_source", ResourceToolActions, "private LocalExecutionReceipt ExecuteBreakRockSource(", "BreakRockSource"),
            ("water_crop", FarmingConstructionActions, "private LocalExecutionReceipt ExecuteWaterCrop(", "WaterCrop"),
        })
        {
            string body = MethodBody(Read(file), signature);
            int restore = body.IndexOf("RestoreToolSelection(Game1.player, selection)", StringComparison.Ordinal);
            int restoredFact = body.IndexOf("evidence[\"tool_restored\"]", StringComparison.Ordinal);
            int compose = body.IndexOf($"ToolActionEvidence.Compose(ToolActionEvidence.{keyList}, evidence)", StringComparison.Ordinal);

            restore.Should().BeGreaterThan(0, $"{actionId} restores the actor's own selection");
            restoredFact.Should().BeGreaterThan(restore, $"{actionId} states the restore only after performing it");
            compose.Should().BeGreaterThan(restoredFact, $"{actionId} composes the receipt once the restore fact exists");
        }
    }

    // ---- helpers -------------------------------------------------------------

    private const string ResourceToolActions = "integrations/stardew/farmhandexecutioncontroller.resourcetoolactions.cs";
    private const string FarmingConstructionActions = "integrations/stardew/farmhandexecutioncontroller.farmingconstructionactions.cs";
    private const string HostAdapter = "host/src/stardew-game-integration-adapter.ts";

    /// <summary>The claim an action's own registration publishes, read through the Mod's own resolver.</summary>
    private static FarmhandActionResourceTemplateClaim? Claim(string actionId) =>
        (FarmhandActionResourceTemplateClaim?)typeof(ExecutionManager)
            .GetMethod("DeclaredToolClaim", BindingFlags.NonPublic | BindingFlags.Static)!
            .Invoke(null, new object?[] { actionId });

    private static DeclaredToolResolution Resolve(IList<Item?> pack, string actionId) =>
        (DeclaredToolResolution)typeof(ExecutionManager)
            .GetMethod("ResolveDeclaredTool", BindingFlags.NonPublic | BindingFlags.Static)!
            .Invoke(null, new object?[] { pack, actionId })!;

    /// <summary>The evidence keys the Host pins, read out of the first key array of one validator's source region.</summary>
    private static IReadOnlyList<string> HostEvidenceKeys(string source, string marker, string endMarker)
    {
        int start = source.IndexOf(marker, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, $"{marker} must exist in the Host adapter");
        int end = source.IndexOf(endMarker, start, StringComparison.Ordinal);
        end.Should().BeGreaterThan(start, $"{endMarker} must follow {marker}");
        string region = source[start..end];
        int arrayStart = region.IndexOf('[', 0);
        int arrayEnd = region.IndexOf(']', arrayStart);
        arrayStart.Should().BeGreaterThanOrEqualTo(0);
        arrayEnd.Should().BeGreaterThan(arrayStart);
        return Regex.Matches(region[arrayStart..arrayEnd], "\"([A-Za-z0-9_]+)\"")
            .Select(match => match.Groups[1].Value)
            .ToArray();
    }

    /// <summary>A tool whose identity and level are the only things the selection reads.</summary>
    private static T SeedTool<T>(string qualifiedItemId, int upgradeLevel)
        where T : Tool
    {
        var tool = (T)FormatterServices.GetUninitializedObject(typeof(T));
        typeof(Item).GetField("_qualifiedItemId", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
            .SetValue(tool, qualifiedItemId);
        typeof(Tool).GetField("upgradeLevel", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
            .SetValue(tool, new NetInt(upgradeLevel));
        return tool;
    }

    private static Axe Axe(int upgradeLevel) => SeedTool<Axe>("(T)Axe", upgradeLevel);

    private static Pickaxe Pickaxe(int upgradeLevel) => SeedTool<Pickaxe>("(T)Pickaxe", upgradeLevel);

    private static WateringCan WateringCan() => SeedTool<WateringCan>("(T)WateringCan", 0);

    private static Hoe Hoe() => SeedTool<Hoe>("(T)Hoe", 0);

    private static FishingRod FishingRod() => SeedTool<FishingRod>("(T)FishingRod", 0);

    private static Shears Shears() => SeedTool<Shears>("(T)Shears", 0);

    private static MilkPail MilkPail() => SeedTool<MilkPail>("(T)MilkPail", 0);

    private static Pan Pan() => SeedTool<Pan>("(T)Pan", 0);

    /// <summary>A scythe is a MeleeWeapon whose own id says so (`MeleeWeapon.isScythe`), never the type alone.</summary>
    private static MeleeWeapon Scythe() => SeedTool<MeleeWeapon>("(W)47", 0);

    /// <summary>An ordinary sword: a MeleeWeapon the selection vocabulary calls `weapon`, not `scythe`.</summary>
    private static MeleeWeapon Sword() => SeedTool<MeleeWeapon>("(W)4", 0);

    private static string ToolCategory(Tool? tool) =>
        (string)typeof(ExecutionManager)
            .GetMethod("DescribeToolCategory", BindingFlags.NonPublic | BindingFlags.Static)!
            .Invoke(null, new object?[] { tool })!;

    /// <summary>The category a snapshot tool slot publishes for one tool, through the Mod's own slot projection.</summary>
    private static string ToolCategoryOfSlot(Tool tool) =>
        ((IReadOnlyList<BridgeToolSlot>)typeof(ExecutionManager)
            .GetMethod("DiscoverToolSlots", BindingFlags.NonPublic | BindingFlags.Static)!
            .Invoke(null, new object?[] { new List<Item?> { tool } })!)[0].Category;

    private static string MethodBody(string source, string signature)
    {
        int index = source.IndexOf(signature, StringComparison.Ordinal);
        index.Should().BeGreaterThanOrEqualTo(0, $"{signature} must exist");
        int opening = source.IndexOf('{', index + signature.Length);
        opening.Should().BeGreaterThanOrEqualTo(0, $"{signature} must have a body");

        int depth = 0;
        for (int position = opening; position < source.Length; position++)
        {
            if (source[position] == '{') depth++;
            else if (source[position] == '}' && --depth == 0)
                return source.Substring(opening, position - opening + 1);
        }

        throw new InvalidOperationException($"{signature} body is not balanced");
    }

    private static string Read(string relative) => File.ReadAllText(RepositorySourcePath(relative));

    private static string RepositorySourcePath(string relative)
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "AGENTS.md")))
            directory = directory.Parent;
        if (directory is null)
            throw new InvalidOperationException("repository root not found");
        return Path.Combine(directory.FullName, relative);
    }
}
