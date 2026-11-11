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
/// pinned at the source instead: every declared-tool action selects, and every exit restores in a <c>finally</c> - held by
/// <see cref="ToolPreconditionUniformityTests"/>, whose population is the catalog rather than a list here. The
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
        // `break_rock_source` and `chop_tree_source` claim ANY upgrade level: `BasicOnly` demanded the level-0 tier the
        // game does not require and refused every tier it accepts, so the action would have stopped working the moment a
        // player upgraded (see `FarmhandResourceTemplateValue.BasicOnly` for the native lines that refute its docblock).
        Claim("break_rock").Should().Be(new FarmhandActionResourceTemplateClaim("tool:pickaxe", FarmhandResourceTemplateValue.AnyUpgrade));
        Claim("chop_tree").Should().Be(new FarmhandActionResourceTemplateClaim("tool:axe", FarmhandResourceTemplateValue.AnyUpgrade));
        Claim("chop_stump").Should().Be(new FarmhandActionResourceTemplateClaim("tool:axe", FarmhandResourceTemplateValue.AnyUpgrade));
        Claim("water_crop").Should().Be(new FarmhandActionResourceTemplateClaim("tool:watering_can", FarmhandResourceTemplateValue.AnyUpgrade));
        // EVERY tool action declares the tool its handler takes, including the two that used to demand the caller hold
        // it first (`clear_hoedirt` drove a pickaxe, `dig_artifact_spot` a hoe, and neither said so on the surface).
        Claim("clear_hoedirt").Should().Be(new FarmhandActionResourceTemplateClaim("tool:pickaxe", FarmhandResourceTemplateValue.AnyUpgrade));
        Claim("dig_artifact_spot").Should().Be(new FarmhandActionResourceTemplateClaim("tool:hoe", FarmhandResourceTemplateValue.AnyUpgrade));
        // till_soil takes no `slot` argument but drives the actor's own hoe, which the handler now takes from this claim
        // rather than requiring the caller to equip it first.
        Claim("till_soil").Should().Be(new FarmhandActionResourceTemplateClaim("tool:hoe", FarmhandResourceTemplateValue.AnyUpgrade));
        // The five measured 2026-11-05: each demanded a tool the pack already held. `scythe_crop`, `refill_watering_can`
        // and `pan_ore` published `ToolSlotMeaning` ("must also be `snapshot.currentToolSlot`") and refused
        // `*_not_equipped_in_requested_slot`; `water_pet_bowl` and `water_slime_hutch_trough` demanded the watering can
        // with NO slot argument at all, so nothing on their surface mentioned a tool. All five now state the category.
        Claim("scythe_crop").Should().Be(new FarmhandActionResourceTemplateClaim("tool:scythe", FarmhandResourceTemplateValue.AnyUpgrade));
        Claim("refill_watering_can").Should().Be(new FarmhandActionResourceTemplateClaim("tool:watering_can", FarmhandResourceTemplateValue.AnyUpgrade));
        Claim("pan_ore").Should().Be(new FarmhandActionResourceTemplateClaim("tool:pan", FarmhandResourceTemplateValue.AnyUpgrade));
        Claim("water_pet_bowl").Should().Be(new FarmhandActionResourceTemplateClaim("tool:watering_can", FarmhandResourceTemplateValue.AnyUpgrade));
        Claim("water_slime_hutch_trough").Should().Be(new FarmhandActionResourceTemplateClaim("tool:watering_can", FarmhandResourceTemplateValue.AnyUpgrade));
        // The last two of the predicate class, repaired the same way: `toggle_tool_light` on 2026-11-06 and `use_raft`
        // after it. Each drives ONE tool subclass the pack carries, so each earned a word in the vocabulary rather than
        // a predicate: `lantern` and `raft`.
        Claim("toggle_tool_light").Should().Be(new FarmhandActionResourceTemplateClaim("tool:lantern", FarmhandResourceTemplateValue.AnyUpgrade));
        Claim("use_raft").Should().Be(new FarmhandActionResourceTemplateClaim("tool:raft", FarmhandResourceTemplateValue.AnyUpgrade));
        // The two words no category can say: `remove_placed_item` needs an Axe OR a Pickaxe, and the container/cask pair
        // need the game's own heavy-hitter predicate. Each word is the refusal word too (`tool_not_owned:<word>`).
        Claim("remove_placed_item").Should().Be(new FarmhandActionResourceTemplateClaim("tool:axe_or_pickaxe", FarmhandResourceTemplateValue.AnyUpgrade));
        Claim("break_container").Should().Be(new FarmhandActionResourceTemplateClaim("tool:heavy_hitter", FarmhandResourceTemplateValue.AnyUpgrade));
        Claim("clear_cask").Should().Be(new FarmhandActionResourceTemplateClaim("tool:heavy_hitter_not_melee_weapon", FarmhandResourceTemplateValue.AnyUpgrade));
        // An action that claims no tool answers no claim: the handler never invents one from its own id.
        Claim("dress_mannequin").Should().BeNull();
    }

    [Fact]
    public void EveryDeclaredToolActionAnswersAnUnsatisfiablePackWithTheCategoryWord()
    {
        // The refusal that SURVIVES has to name something real and reachable. `*_not_equipped_in_requested_slot` told
        // the model it should have equipped first - work the action is supposed to do for it, and a plan node died on
        // it; `tool_not_owned:<category>` says the pack cannot satisfy the claim at all, so no different request can
        // repair it. Population: the catalog, so an action added tomorrow is enrolled without touching this file.
        IReadOnlyList<FarmhandActionRegistration> declared = FarmhandActionCatalog.Registrations
            .Where(registration => registration.Descriptor?.ResourceTemplate
                .Any(claim => claim.Key.StartsWith("tool:", StringComparison.Ordinal)) == true)
            .ToArray();
        declared.Should().NotBeEmpty("the catalog must declare tool actions, or this gate reads nothing");

        // One seeded representative per published category, and the vocabulary check that keeps the loop honest: a
        // category the surface can name but this map cannot build would silently narrow the population below.
        var representatives = new Dictionary<string, Tool>(StringComparer.Ordinal)
        {
            ["axe"] = Axe(upgradeLevel: 0),
            ["pickaxe"] = Pickaxe(upgradeLevel: 0),
            ["hoe"] = Hoe(),
            ["watering_can"] = WateringCan(),
            ["fishing_rod"] = FishingRod(),
            ["scythe"] = Scythe(),
            ["weapon"] = Sword(),
            ["shears"] = Shears(),
            ["milk_pail"] = MilkPail(),
            ["pan"] = Pan(),
            ["lantern"] = Lantern(),
            ["raft"] = Raft(),
        };
        FarmhandActionCatalog.ToolEnum.Should().BeEquivalentTo(representatives.Keys);

        var wrongWords = new List<string>();
        foreach (FarmhandActionRegistration registration in declared)
        {
            string category = registration.Descriptor!.ResourceTemplate
                .First(claim => claim.Key.StartsWith("tool:", StringComparison.Ordinal)).Key["tool:".Length..];
            // An empty pack, and a pack holding every tool that does NOT satisfy the claim: neither may answer anything
            // but the one word. The second case is also what separates "you own no scythe" from "you own the wrong
            // tool" - the action must not borrow a neighbour's tool to avoid refusing. Which tools those are is the
            // vocabulary's own answer, so a predicate word (`axe_or_pickaxe`, `heavy_hitter`) is covered without a
            // second list here.
            foreach (IList<Item?> pack in new IList<Item?>[]
            {
                new List<Item?>(),
                representatives.Where(entry => !Satisfies(category, entry.Value))
                    .Select(entry => (Item?)entry.Value)
                    .ToList(),
            })
            {
                DeclaredToolResolution resolution = Resolve(pack, registration.ActionId);
                if (!string.Equals(resolution.RefusalCode, $"tool_not_owned:{category}", StringComparison.Ordinal))
                    wrongWords.Add($"{registration.ActionId} (expected tool_not_owned:{category}, got {resolution.RefusalCode ?? "no refusal"})");
            }

            // The second pack is the one that matters: a handler that borrowed the neighbour's tool would answer
            // `no refusal` for a pack holding every tool except the one its claim names.
        }

        wrongWords.Should().BeEmpty(
            "a pack that holds no tool of the claimed category must be refused with `tool_not_owned:<category>` - the "
                + "one word that says the pack cannot be repaired by a different request:\n  "
                + string.Join("\n  ", wrongWords));
    }

    [Fact]
    public void EveryDeclaredToolWordIsOneTheSelectionVocabularyKnows()
    {
        // The word reaches the matcher verbatim, so a `tool:<word>` claim the vocabulary does not know would resolve to
        // "not owned" forever. The vocabulary is the published category enum PLUS the predicate table's own words, read
        // from the table rather than restated, so a new word is enrolled by the code that answers it.
        var vocabulary = new HashSet<string>(FarmhandActionCatalog.ToolEnum, StringComparer.Ordinal);
        vocabulary.UnionWith(ExecutionManager.ToolRequirementPredicates.Keys);
        int population = 0;
        foreach (FarmhandActionRegistration registration in FarmhandActionCatalog.Registrations)
        {
            foreach (FarmhandActionResourceTemplateClaim claim in registration.Descriptor?.ResourceTemplate
                ?? Array.Empty<FarmhandActionResourceTemplateClaim>())
            {
                if (!claim.Key.StartsWith("tool:", StringComparison.Ordinal))
                    continue;
                population++;
                vocabulary.Should().Contain(claim.Key["tool:".Length..],
                    $"{registration.ActionId} claims a tool the selection vocabulary must be able to match");
            }
        }

        population.Should().BeGreaterThan(0, "the population comes from the catalog; zero means the derivation stopped");
    }

    [Fact]
    public void ThePredicateWordsAnswerTheNativeQuestionsTheyName()
    {
        // Each row is a fact read off the game, not off this suite's own matcher: `Tool.isHeavyHitter` is
        // `MeleeWeapon || Hoe || Axe || Pickaxe` (Tool.cs:427-434), the cask adds `&& !(t is MeleeWeapon)`
        // (Cask.cs:43), and `remove_placed_item`'s two seams are Axe.DoFunction and Pickaxe.DoFunction. A word that
        // drifted from its predicate would tell a caller to fetch a tool the handler never looks for.
        (string Word, string Satisfied, string NotSatisfied)[] rows =
        {
            ("axe_or_pickaxe", "axe,pickaxe", "hoe,watering_can,fishing_rod,scythe,weapon,shears,milk_pail,pan,lantern,raft"),
            ("heavy_hitter", "axe,pickaxe,hoe,scythe,weapon", "watering_can,fishing_rod,shears,milk_pail,pan,lantern,raft"),
            ("heavy_hitter_not_melee_weapon", "axe,pickaxe,hoe", "scythe,weapon,watering_can,fishing_rod,shears,milk_pail,pan,lantern,raft"),
        };
        var representatives = new Dictionary<string, Tool>(StringComparer.Ordinal)
        {
            ["axe"] = Axe(upgradeLevel: 0),
            ["pickaxe"] = Pickaxe(upgradeLevel: 0),
            ["hoe"] = Hoe(),
            ["watering_can"] = WateringCan(),
            ["fishing_rod"] = FishingRod(),
            ["scythe"] = Scythe(),
            ["weapon"] = Sword(),
            ["shears"] = Shears(),
            ["milk_pail"] = MilkPail(),
            ["pan"] = Pan(),
            ["lantern"] = Lantern(),
            ["raft"] = Raft(),
        };

        foreach ((string word, string satisfied, string notSatisfied) in rows)
        {
            ExecutionManager.ToolRequirementPredicates.Should().ContainKey(word, "the table is the authority for the vocabulary");
            foreach (string category in satisfied.Split(','))
                Satisfies(word, representatives[category]).Should().BeTrue($"{word} names a tool {category} answers natively");
            foreach (string category in notSatisfied.Split(','))
                Satisfies(word, representatives[category]).Should().BeFalse($"{word} must not admit a {category}");
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
    public void AnUpgradedPickaxeSatisfiesTheClaimAndIsPreferred()
    {
        // The INVERSE of what this test asserted until 2026-10-30, and the reason comes from the game rather than taste:
        // `Pickaxe` refuses `UpgradeLevel < 2` (Pickaxe.cs:186) - it demands MORE than the basic tier - and `Axe` refuses
        // no upgrade level at all. The old `BasicOnly` claim therefore admitted the one tier the game rejects and refused
        // every tier it accepts, so a player who upgraded an axe would have lost tree-felling permanently.
        DeclaredToolResolution upgradedOnly = Resolve(new List<Item?> { Pickaxe(upgradeLevel: 1) }, "break_rock");

        upgradedOnly.RefusalCode.Should().BeNull("an upgraded pickaxe is the tool the game expects");
        upgradedOnly.Slot.Should().Be(0);

        // With both owned the BEST one wins - the opposite ranking to the old one, because the requirement is a floor
        // rather than a pinned tier.
        DeclaredToolResolution both = Resolve(
            new List<Item?> { Axe(upgradeLevel: 0), Pickaxe(upgradeLevel: 2), Pickaxe(upgradeLevel: 0) },
            "break_rock");

        both.RefusalCode.Should().BeNull();
        both.Slot.Should().Be(1, "the level-2 pickaxe outranks the level-0 one");
    }

    [Fact]
    public void AMissingToolIsNamedSeparatelyFromATierMismatch()
    {
        // "you do not own one" and "you own the wrong tier" are different repairs: the first cannot be fixed by the Mod,
        // the second means the surface promised something the pack cannot satisfy.
        Resolve(new List<Item?> { Axe(upgradeLevel: 0) }, "cut_weeds").RefusalCode.Should().Be("tool_not_owned:scythe");
        // An upgraded pickaxe now SATISFIES the claim, so a tier mismatch is only reachable through a claim that
        // declares a floor above the owned level - `ResolveDeclaredTool` still refuses by name when one does.
        Resolve(new List<Item?> { Pickaxe(upgradeLevel: 3) }, "break_rock").RefusalCode.Should().BeNull();
    }

    [Fact]
    public void EveryToolActionStillPublishesExactlyTheEvidenceKeysTheHostPins()
    {
        // The Host recognises a success by a DECLARED receipt-detail key set
        // (`host/src/stardew-game-integration-adapter.ts`: the cut_weeds/cut_grass branches pass their keys to
        // `declaredCompletionEvidence`, and `hasWaterCropCompletionEvidence` / `hasBreakRockSourceCompletionEvidence`
        // still compare key counts). The Mod states each set once, in ToolActionEvidence, so the paired change is one
        // edit - and this test is what makes a drift between the two sides fail HERE instead of in a live run.
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
            ("lantern", Lantern()),
            ("raft", Raft()),
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
    public void EveryToolActionThatPublishesTheSelectionFactsComposesItsReceiptAfterTheRestore()
    {
        // `tool_restored` may only be written after the finally has put the actor's selection back, and the receipt is
        // composed after that - so the key can never describe a restore that has not happened. Reordering either half
        // fails here rather than shipping a receipt that asserts an unperformed restore.
        //
        // The population is exactly the actions that PUBLISH those facts; the other tool actions select and restore
        // without publishing them (they say so at their own selection call), so asking them for `tool_restored` would
        // be asking for a key their Host validator refuses. `ToolPreconditionUniformityTests` is what holds the
        // selection itself across every declared tool action.
        foreach ((string actionId, string file, string signature, string keyList) in new[]
        {
            ("cut_weeds", ResourceToolActions, "private LocalExecutionReceipt ExecuteCutWeeds(", "CutWeeds"),
            ("cut_grass", ResourceToolActions, "private LocalExecutionReceipt ExecuteCutGrass(", "CutGrass"),
            ("break_rock", ResourceToolActions, "private LocalExecutionReceipt ExecuteBreakRockSource(", "BreakRockSource"),
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

    /// <summary>Whether one tool satisfies the WORD a claim names, asked through the Mod's own vocabulary.</summary>
    private static bool Satisfies(string word, Tool tool) => ExecutionManager.SatisfiesToolRequirement(tool, word);

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

    /// <summary>The tool `toggle_tool_light` takes: its word entered the vocabulary with that action.</summary>
    private static Lantern Lantern() => SeedTool<Lantern>("(T)Lantern", 0);

    /// <summary>The tool `use_raft` takes, and the one no list of categories could have named before it.</summary>
    private static Raft Raft() => SeedTool<Raft>("(T)Raft", 0);

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
