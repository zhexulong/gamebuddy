using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Handlers;
using Netcode;
using StardewValley;
using StardewValley.Tools;
using Xunit;
using static GameBuddy.Stardew.Integration.Tests.TargetFamilyCompletenessTests;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// `fish_here`: the four pre-cast refusals, and the completion seam that makes a catch the ENGINE's catch.
///
/// <para>
/// WHAT THIS FILE CANNOT DRIVE, AND WHY (each is a live-run item, not a gap in the unit):
/// </para>
/// <list type="bullet">
/// <item>
/// <c>water_not_fishable:tile_not_fishable</c> and <c>water_not_fishable:location_cannot_fish</c> - both are answers
/// about a WATER tile, and `TargetFamilyWorld`'s map declares Back/Buildings/Front layers with no tile PROPERTIES at
/// all, so `isWaterTile` is false on every tile it can build. The refusals themselves are exercised (the `not_water`
/// sibling below runs through the same three-clause block) and the codes are asserted present by
/// <see cref="RefusalVocabularyIsClosedAndEveryRefusalPrecedesTheCast"/>.
/// </item>
/// <item>
/// <c>rod_not_equipped</c> - it is minted when the pack HOLDS a rod that `Farmer.CurrentTool` refuses to become after
/// `CurrentToolIndex` is set, or when the resolved slot does not hold a `FishingRod`. Neither is a state a headless pack
/// can be put into: `Farmer.CurrentTool` is a pure index read, so the two disagree only if the engine itself is
/// inconsistent. The code is asserted present by the same vocabulary gate.
/// </item>
/// <item>
/// THE SUCCESSFUL CATCH. The engine's own path needs `DataLoader.Fish(Game1.content)` - read by `BobberBar`'s
/// constructor (<c>BobberBar.cs:151</c>) for the size range and difficulty, and by `GameLocation.GetFishFromLocationData`
/// (<c>GameLocation.cs:13908</c>) for the fish table - and this process has no content manager. It also needs the rod's
/// frame-driven tool tick to reach the bite. Both are live-run facts.
/// </item>
/// </list>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the behaviour cases measure what a fishing action does, and the shape pins fix the source constructs they depend on. Keep them together: a pin that guarded a construct nothing else used would be dead weight, and a behaviour case whose construct drifted silently would read green against the wrong code.
public sealed class FishingActionTests
{
    private const string FishingPartial = "integrations/stardew/farmhandexecutioncontroller.fishingactions.cs";
    private const string WaterTargetIdPrefix = "water_";

    /// <summary>
    /// The card's failure vocabulary is CLOSED and every member of it is spent BEFORE the cast: no `fish_escaped`,
    /// no `no_bite_in_window`, and no refusal minted after `DoFunction(...)` has been called.
    ///
    /// <para>
    /// The post-cast assertion is the one that stops the card's ruling from decaying: a settlement-time failure code
    /// added later (the natural thing to write when a bite is slow) turns a turn into a bet, and this fails by name.
    /// </para>
    /// </summary>
    [Fact]
    public void RefusalVocabularyIsClosedAndEveryRefusalPrecedesTheCast()
    {
        string source = FishingSource();

        foreach (string code in new[]
                 {
                     "no_rod_in_inventory",
                     "rod_not_equipped",
                     "water_not_fishable:",
                     "no_bait_available",
                     "out_of_stamina",
                 })
            source.Should().Contain(code, $"the card's closed vocabulary names {code} and the handler must mint it");

        foreach (string forbidden in new[] { "fish_escaped", "no_bite_in_window" })
            source.Should().NotContain(forbidden,
                "a settlement-time failure code turns a turn into a bet, which the card forbids outright");

        int cast = source.IndexOf("rod.DoFunction(", StringComparison.Ordinal);
        cast.Should().BeGreaterThan(0, "the handler must run the engine's own cast");
        // EVERY rejection, not just the ones minted through `Refuse`: a rejection written directly as a receipt after the
        // cast would be the same defect, and matching the state literal catches both spellings.
        int lastRejection = source.LastIndexOf("ExecutionState.Rejected", StringComparison.Ordinal);
        lastRejection.Should().BeGreaterThan(0, "the handler must mint its refusals by name");
        lastRejection.Should().BeLessThan(cast,
            "every refusal must be spent before a byte is cast: a refusal after DoFunction has already spent stamina");
    }

    /// <summary>
    /// THE COMPLETION SEAM, and the red proof that it is the seam.
    ///
    /// <para>
    /// The card was written on the premise that `FishingRod.doneFishing` books a catch. It does not: `doDoneFishing`
    /// (<c>FishingRod.cs:1749-1825</c>) consumes bait and tackle and clears the rod's own flags, and `farmer.fishCaught`
    /// is written in exactly one place - `playerCaughtFishEndFunction` (<c>:1104</c>) - reached only through
    /// `pullFishFromWater` (<c>:1137</c>). This gate asserts that the shipped handler goes through that call, settles
    /// with the engine's own `doneHoldingFish` (<c>:2304</c>, the same function a player reaches by clicking the held
    /// fish), and that `Succeeded` is bound to the engine's own credit fact rather than being a branch default.
    /// </para>
    ///
    /// <para>
    /// The mutation half is the red proof: delete the `pullFishFromWater` call from a copy of the source and the same
    /// predicate reports `missing_credit_call:pullFishFromWater`. Without it, deleting the line would leave the first
    /// assertion as the only witness - a test that cannot tell what it is protecting.
    /// </para>
    /// </summary>
    [Fact]
    public void CompletionRunsTheEnginesOwnCreditSeamAndSuccessIsConditional()
    {
        string source = FishingSource();

        CompletionSeamViolations(source).Should().BeEmpty(
            "the catch must be credited by the engine's own win path, and success must be its answer rather than ours");

        string withoutCredit = source.Replace("rod.pullFishFromWater(", "/* removed */", StringComparison.Ordinal);
        CompletionSeamViolations(withoutCredit).Should().Contain("missing_credit_call:pullFishFromWater",
            "removing the engine's credit call must be reported BY NAME, so the seam the catch depends on is the tested fact");

        string withoutSettle = source.Replace("rod.doneHoldingFish(", "/* removed */", StringComparison.Ordinal);
        CompletionSeamViolations(withoutSettle).Should().Contain("missing_settle_call:doneHoldingFish",
            "the bait/tackle consumption and the inventory add live in the engine's own settle, not in a copy of it");

        string withoutCreditBinding = source.Replace("credited ? ExecutionState.Succeeded : ExecutionState.Uncertain", "ExecutionState.Succeeded", StringComparison.Ordinal);
        CompletionSeamViolations(withoutCreditBinding).Should().Contain("success_not_bound_to_engine_credit",
            "an unconditional Succeeded is exactly the default-success shape the card forbids");
    }

    /// <summary>
    /// The four refusals the card names, each by its own code, each spending NOTHING: the actor's stamina, the bait in
    /// the rod, the tackle on it, her catch record and the tool in her hand are all identical after the refusal.
    /// </summary>
    [Theory]
    [InlineData("no_rod_in_inventory")]
    [InlineData("no_bait_available")]
    [InlineData("out_of_stamina")]
    [InlineData("water_not_fishable:not_water")]
    public void RefusalNamesTheCodeAndConsumesNothing(string expectedCode)
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        switch (expectedCode)
        {
            case "no_rod_in_inventory":
                break;
            case "no_bait_available":
                // A rod with an attachment slot and nothing in it. `CanUseBait` is `numAttachmentSlots > 0`
                // (Tool.cs:189-199), and `PutToolInPackSlot` leaves an uninitialized tool's slots at zero, so the
                // slot count is seeded here rather than in the shared harness.
                world.PutToolInPackSlot(0, typeof(FishingRod), "(T)FishingRod", upgradeLevel: 1);
                SetAttachmentSlots((Tool)world.Actor.Items[0]!, 1);
                break;
            case "out_of_stamina":
                world.PutToolInPackSlot(0, typeof(FishingRod), "(T)FishingRod", upgradeLevel: 0);
                world.Actor.Stamina = 1f;
                break;
            default:
                world.PutToolInPackSlot(0, typeof(FishingRod), "(T)FishingRod", upgradeLevel: 0);
                break;
        }

        FishingRod? rod = world.Actor.Items[0] as FishingRod;
        // The engine's catch record is one of the four things a refusal must leave alone, so it is present here: a null
        // record would make that assertion vacuous.
        SeedCatchRecord(world.Actor);
        float staminaBefore = world.Actor.Stamina;
        string? baitBefore = rod?.GetBait()?.QualifiedItemId;
        int tackleBefore = rod?.GetTackleQualifiedItemIDs().Count ?? 0;
        int caughtBefore = world.Actor.fishCaught.Length;
        int heldSlotBefore = world.Actor.CurrentToolIndex;

        LocalExecutionReceipt receipt = CastAt(world, x: 2, y: 3);

        receipt.State.Should().Be(ExecutionState.Rejected, "every refusal is a refusal, not a silent no-op");
        receipt.ReasonCode.Should().Be(expectedCode);

        world.Actor.Stamina.Should().Be(staminaBefore, "a refused cast must not have spent a point of stamina");
        (rod?.GetBait()?.QualifiedItemId).Should().Be(baitBefore, "a refused cast must not have consumed bait");
        (rod?.GetTackleQualifiedItemIDs().Count ?? 0).Should().Be(tackleBefore, "a refused cast must not have worn tackle");
        world.Actor.fishCaught.Length.Should().Be(caughtBefore, "a refused cast must not have booked a fish");
        rod?.inUse().Should().NotBe(true, "nothing may be left fishing after a refusal");
        world.Actor.CurrentToolIndex.Should().Be(heldSlotBefore,
            "the slot the action selected is restored on every exit, so the actor holds what she held before");
    }

    /// <summary>
    /// A refusal is asked BEFORE the walk: with a pack that holds no rod, a target twenty tiles away is still the rig's
    /// answer rather than an `accepted` approach leg that the action could never finish. This is the shape
    /// `refill_watering_can` already keeps, and it is why the pre-walk preflight and the arrival preflight are one method.
    /// </summary>
    [Fact]
    public void RefusalIsAskedBeforeTheWalk()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();

        LocalExecutionReceipt receipt = CastAt(world, x: 12, y: 12);

        receipt.State.Should().Be(ExecutionState.Rejected,
            "an empty pack is refused now, not after a walk the action could never finish");
        receipt.ReasonCode.Should().Be("no_rod_in_inventory");
    }

    /// <summary>
    /// The published family and the action's address are ONE function: the tile a row names is the tile the handler
    /// resolves, asked of the production builder rather than reproduced here.
    /// </summary>
    [Fact]
    public void WaterTargetIdIsTheActionsOwnAddress()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();

        string id = ExecutionManager.BuildWaterTargetId(world.Farm, 4, 6);

        id.Should().StartWith(WaterTargetIdPrefix, "the family's ids are recognisable by their own prefix");
        ExecutionManager.BuildWaterTargetId(world.Farm, 4, 6).Should().Be(id, "the address is a pure function of location and tile");
        ExecutionManager.BuildWaterTargetId(world.Farm, 6, 4).Should().NotBe(id, "the tile is part of the address, in order");
    }

    /// <summary>What the shipped completion path must contain, as a pure predicate so a mutated copy can be judged too.</summary>
    private static IReadOnlyList<string> CompletionSeamViolations(string source)
    {
        var violations = new List<string>();
        void Require(string text, string violation)
        {
            if (!source.Contains(text, StringComparison.Ordinal)) violations.Add(violation);
        }

        // The engine's credit call, the value it is called with, and the engine's own settle.
        Require("rod.pullFishFromWater(", "missing_credit_call:pullFishFromWater");
        Require("rod.doneHoldingFish(", "missing_settle_call:doneHoldingFish");
        Require("bar.fishSize", "missing_engine_size:bar.fishSize");
        Require("bar.fishQuality", "missing_engine_quality:bar.fishQuality");
        // The credit fact itself, and the state that depends on it.
        Require("rod.fishCaught", "missing_engine_credit_fact:rod.fishCaught");
        Require("caughtAfter > spec.CaughtCountBefore", "missing_credit_before_after:fishCaught");
        Require("credited ? ExecutionState.Succeeded : ExecutionState.Uncertain", "success_not_bound_to_engine_credit");
        Require("fish_here_catch_not_credited", "missing_uncredited_code");
        // `was_perfect` is a DECLARED property of this action, and the receipt has to say so.
        Require("was_perfect_basis=declared_by_action", "was_perfect_presented_as_observation");
        return violations;
    }

    /// <summary>
    /// WHEN THE ENGINE DOES NOT CREDIT THE CATCH, THE ACTION SAYS SO BY NAME. This is the runtime half of the card's
    /// "remove the seam" proof: with the credit fact absent the cast settles `Uncertain/fish_here_catch_not_credited`,
    /// which is a named failure rather than the branch default `Succeeded`.
    ///
    /// <para>
    /// The cast is put into its post-win phase directly because reaching it through the engine needs the catch window
    /// (`BobberBar`) and therefore `Data/Fish` - see the class docblock. What is driven here is the decision the phase
    /// exists for: `rod.fishCaught` false means nothing was booked, and nothing booked cannot be reported as `fish_caught`.
    /// </para>
    /// </summary>
    [Fact]
    public void MissingEngineCreditIsANamedFailureRatherThanSuccess()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        world.PutToolInPackSlot(0, typeof(FishingRod), "(T)FishingRod", upgradeLevel: 0);
        world.Actor.CurrentToolIndex = 0;
        // The record this fish WOULD have been written to: held at zero, so the failure under test is "the engine booked
        // nothing", not "the record was absent and therefore unreadable".
        SeedCatchRecord(world.Actor, ("(O)128", 0, 0));
        ExecutionManager executions = world.NewExecutionManager("fish_here");

        long past = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - 1_000;
        var spec = new LocalFishingCastSpec(
            "exec_missing_credit",
            "req_missing_credit",
            world.Farm.NameOrUniqueName,
            2,
            3,
            ExecutionManager.BuildWaterTargetId(world.Farm, 2, 3),
            RodSlot: 0,
            PreviousSlot: 0,
            StaminaBefore: world.Actor.Stamina,
            BaitBefore: 0,
            StartedAtMs: past - 5_000,
            DeadlineMs: past,
            LocalFishingPhase.AwaitingCredit,
            CaughtQualifiedItemId: "(O)128",
            CaughtFishSize: 12,
            CaughtFishQuality: 1,
            CaughtCountBefore: 0);
        typeof(ExecutionManager)
            .GetField("activeFishing", BindingFlags.Instance | BindingFlags.NonPublic)!
            .SetValue(executions, spec);

        typeof(ExecutionManager)
            .GetMethod("UpdateFishingCast", BindingFlags.Instance | BindingFlags.NonPublic)!
            .Invoke(executions, null);

        executions.TryGetReceipt("req_missing_credit", out LocalExecutionReceipt receipt).Should().BeTrue();
        receipt!.State.Should().Be(ExecutionState.Uncertain,
            "a catch the engine never booked is uncertain, never a success");
        receipt.ReasonCode.Should().Be("fish_here_catch_not_credited");
        // Same code, same record, named with both of its readings: the negative answer is an observation too.
        receipt.Evidence.Should().Contain("credit=fishCaught:0->0",
            "the credit record is named with the reading before and after, so `not credited` can be told from `not read`");
        typeof(ExecutionManager)
            .GetField("activeFishing", BindingFlags.Instance | BindingFlags.NonPublic)!
            .GetValue(executions).Should().BeNull("the cast's slot is released on every exit");
    }

    /// <summary>
    /// THE CREDIT IS READ FROM THE RECORD THE ENGINE KEEPS, UNDER THE KEY THE ENGINE WRITES.
    ///
    /// <para>
    /// `Farmer.caughtFish` stores the count under `metadata.QualifiedItemId` (`Farmer.cs:2995-2996`), while the bar this
    /// action reads is built with the fish's RAW id (`FishingRod.cs:939` -> `BobberBar.cs:150`). Measured live 2026-11-10:
    /// `fish_here` landed a sunfish, spent the bait (20 -> 19) and the stamina, collected it through the engine's own
    /// `doneHoldingFish` - and answered `fish_here_catch_not_credited` with `caught_qualified_item_id=145`, because both
    /// readings of the record were taken under a key the engine never wrote (`0 -> 0`). The verdict was right to refuse an
    /// unproven catch; the READ is what was wrong.
    /// </para>
    ///
    /// <para>
    /// THREE THINGS ARE PINNED, each with its own injected violation: the record (the farmer's, not the rod's transient
    /// flag), the key (the engine's qualified id), and the ORDER (a reading before the win path, the same reading after
    /// it). The order is the whole defect - a "before" taken after the engine has written has nothing to compare with.
    /// </para>
    /// </summary>
    [Fact]
    public void TheCreditIsReadFromTheEnginesOwnRecordUnderTheEnginesOwnKey()
    {
        string source = FishingSource();

        CreditReadViolations(source).Should().BeEmpty(
            "the catch must be credited by the engine's own saved record, before and after its own win path");

        string rawKey = source.Replace("ItemRegistry.QualifyItemId(bar.whichFish)", "bar.whichFish", StringComparison.Ordinal);
        CreditReadViolations(rawKey).Should().Contain("credit_key_not_the_engines_qualified_id",
            "reading the record with the bar's raw id is the shipped defect, and it must be reported by name");

        const string beforeRead = "int countBefore = ReadCaughtCount(Game1.player, fishQualifiedItemId);";
        string lateBefore = source
            .Replace(beforeRead, string.Empty, StringComparison.Ordinal)
            .Replace("CaughtCountBefore = countBefore,", beforeRead + "\n                        CaughtCountBefore = countBefore,", StringComparison.Ordinal);
        CreditReadViolations(lateBefore).Should().Contain("credit_before_reading_after_the_win_path",
            "a before-reading taken once the engine has already written leaves nothing for the after-reading to be compared against");

        string withoutAfter = source.Replace("int caughtAfter = ReadCaughtCount(Game1.player, fishQualifiedItemId);", string.Empty, StringComparison.Ordinal);
        CreditReadViolations(withoutAfter).Should().Contain("missing_credit_after_reading",
            "the credit is a delta, so a missing second reading is a missing credit");

        string rodFlag = source.Replace(
            "player.fishCaught.TryGetValue(qualifiedItemId, out int[]? entry) ? entry[0] : 0",
            "rod?.fishCaught == true ? 1 : 0",
            StringComparison.Ordinal);
        CreditReadViolations(rodFlag).Should().Contain("credit_record_is_not_the_farmers_catch_record",
            "the rod's own flag is cleared by the settle (`FishingRod.cs:2352`) and can never answer what the engine booked");

        string flatIsCredited = source.Replace("caughtAfter > spec.CaughtCountBefore", "caughtAfter >= spec.CaughtCountBefore", StringComparison.Ordinal);
        CreditReadViolations(flatIsCredited).Should().Contain("credit_decision_is_not_the_record_delta",
            "a flat record credited as a catch is the default-success shape the card forbids");

        string unnamedRecord = source.Replace("credit=fishCaught:", "credit=", StringComparison.Ordinal);
        CreditReadViolations(unnamedRecord).Should().Contain("credit_receipt_does_not_name_the_record",
            "the receipt has to name the record that proved the catch, not just that something proved it");
    }

    /// <summary>
    /// THE KEY ITSELF, driven against the production read. `Farmer.caughtFish` normalises the id it is handed
    /// (`Farmer.cs:2995-2996`) and keys the count by the QUALIFIED one, so the raw id the catch window publishes reads a
    /// row the engine never writes - and returns the same zero before and after a real catch.
    /// </summary>
    [Fact]
    public void TheCatchRecordIsKeyedByTheEnginesQualifiedItemId()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        SeedCatchRecord(world.Actor, ("(O)145", 3, 9));
        ExecutionManager.ReadCaughtCount(world.Actor, "(O)145").Should().Be(3,
            "the count is read under the qualified id, which is the key `Farmer.caughtFish` writes");
        ExecutionManager.ReadCaughtCount(world.Actor, "145").Should().Be(0,
            "the raw id the catch window carries is not a key the engine ever writes, so a raw-key read is a silent zero - which is how a recorded catch was reported as `fish_here_catch_not_credited`");
        ExecutionManager.ReadCaughtCount(world.Actor, "(O)128").Should().Be(0,
            "a fish the record does not hold yet reads as zero rather than throwing");
    }

    /// <summary>
    /// What the credit read must BE, as a pure predicate so a mutated copy can be judged too: the engine's own saved
    /// record, under the engine's own key, read on both sides of the engine's own win path, and named in the receipt.
    /// </summary>
    private static IReadOnlyList<string> CreditReadViolations(string source)
    {
        var violations = new List<string>();
        void Require(string text, string violation)
        {
            if (!source.Contains(text, StringComparison.Ordinal)) violations.Add(violation);
        }

        Require("player.fishCaught.TryGetValue(qualifiedItemId", "credit_record_is_not_the_farmers_catch_record");
        Require("ItemRegistry.QualifyItemId(bar.whichFish)", "credit_key_not_the_engines_qualified_id");
        Require("caughtAfter > spec.CaughtCountBefore", "credit_decision_is_not_the_record_delta");
        Require("credit=fishCaught:", "credit_receipt_does_not_name_the_record");

        int beforeRead = source.IndexOf("int countBefore = ReadCaughtCount(Game1.player, fishQualifiedItemId);", StringComparison.Ordinal);
        int winPath = source.IndexOf("rod.pullFishFromWater(", StringComparison.Ordinal);
        int afterRead = source.IndexOf("int caughtAfter = ReadCaughtCount(Game1.player, fishQualifiedItemId);", StringComparison.Ordinal);
        if (beforeRead < 0) violations.Add("missing_credit_before_reading");
        if (afterRead < 0) violations.Add("missing_credit_after_reading");
        if (winPath < 0) violations.Add("missing_credit_call:pullFishFromWater");
        if (beforeRead >= 0 && winPath >= 0 && beforeRead > winPath) violations.Add("credit_before_reading_after_the_win_path");
        if (afterRead >= 0 && winPath >= 0 && afterRead < winPath) violations.Add("credit_after_reading_before_the_win_path");
        return violations;
    }

    /// <summary>
    /// The engine's catch record on an uninitialized farmer: `Farmer.fishCaught` is a readonly FIELD INITIALIZER
    /// (`Farmer.cs:758`) that a headless instance never ran, and `NetStringIntArrayDictionary`'s constructor is not public,
    /// so `TargetFamilyWorld` cannot supply it the way it supplies the other NetFields. One spelling for both tests that
    /// need the record, so the COUNT they agree on cannot drift from the KEY they agree on.
    /// </summary>
    private static void SeedCatchRecord(Farmer actor, params (string QualifiedItemId, int Count, int Size)[] entries)
    {
        var record = new NetStringIntArrayDictionary();
        foreach (var entry in entries) record[entry.QualifiedItemId] = new[] { entry.Count, entry.Size };
        typeof(Farmer)
            .GetField("fishCaught", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)!
            .SetValue(actor, record);
    }

    /// <summary>One cast dispatched through the production handler, against the real probe world.</summary>
    private static LocalExecutionReceipt CastAt(TargetFamilyWorld world, int x, int y)
    {
        ExecutionManager executions = world.NewExecutionManager("fish_here");
        var handler = new ResourceToolActionHandler(executions);
        long deadline = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000;
        return handler.Execute(
            new BridgeExecutionRequest(
                $"probe_fish_here_{x}_{y}",
                $"probe_fish_here_{x}_{y}",
                "fish_here",
                new BridgeExecutionArgs
                {
                    X = x,
                    Y = y,
                    ExpectedTargetId = ExecutionManager.BuildWaterTargetId(world.Farm, x, y),
                },
                1,
                deadline),
            executions);
    }

    /// <summary>`Tool.attachments` is a `NetObjectArray` sized from `numAttachmentSlots`; both are seeded together.</summary>
    private static void SetAttachmentSlots(Tool tool, int slots)
    {
        typeof(Tool)
            .GetField("numAttachmentSlots", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)!
            .SetValue(tool, new NetInt(slots));
        object attachments = typeof(Tool)
            .GetField("attachments", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)!
            .GetValue(tool)!;
        attachments.GetType().GetMethod("SetCount")!.Invoke(attachments, new object[] { slots });
    }

    /// <summary>The shipped partial, read from the repository root the test assembly was built inside.</summary>
    private static string FishingSource()
    {
        DirectoryInfo? directory = new(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, FishingPartial)))
            directory = directory.Parent;
        directory.Should().NotBeNull($"the Mod source `{FishingPartial}` must be reachable from the test's own directory");
        return File.ReadAllText(Path.Combine(directory!.FullName, FishingPartial));
    }
}
