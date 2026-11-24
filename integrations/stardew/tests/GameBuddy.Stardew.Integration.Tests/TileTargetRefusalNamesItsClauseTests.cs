using System;
using System.Reflection;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using Microsoft.Xna.Framework;
using StardewValley;
using Xunit;
using static GameBuddy.Stardew.Integration.Tests.TargetFamilyCompletenessTests;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A REFUSAL THAT COVERS SEVERAL FACTS NAMES WHICH ONE REFUSED IT. Six actions answer one code for a whole family of
/// clauses - a tile with no soil, a tile holding a garden pot, a tile whose crop is already watered - and until the
/// clause travels in the evidence, a caller reading that code learns only that something was wrong.
///
/// <para>
/// MEASURED `round84`: twenty-one <c>plant_seed</c> requests, zero successes, every one <c>seed_target_unavailable</c>.
/// The pack half was never the answer (it is asked first and has its own code), so all twenty-one were one of five tile
/// clauses - and the receipt could not say which, which is why the round cost another day.
/// </para>
///
/// <para>
/// EVERY CLAUSE IS REACHED HERE, AND THE FOUR THAT CANNOT BE ARE NAMED AS SUCH. A clause that reads game content
/// (<c>Data/Crops</c>, <c>Data/Machines</c>) cannot answer in a process that loads none, and a clause that sits BEHIND
/// such a read cannot be reached either. Those rows say so in their own names and assert the ordering that makes it
/// true, so the day content arrives they fail and become behaviour cases instead of quietly staying explanations.
/// </para>
/// </summary>
public sealed class TileTargetRefusalNamesItsClauseTests
{
    /// <summary>One step from the actor: inside every radius these actions use for their native call.</summary>
    private const int TileX = 3;
    private const int TileY = 2;

    private const string ParsnipSeeds = "(O)472";
    private const string Fertilizer = "(O)368";
    private const string OtherFertilizer = "(O)369";
    private const string Bait = "(O)685";
    private const string PlainObject = "(O)390";

    // ---- plant_seed ---------------------------------------------------------------------------------------------

    /// <summary>
    /// Four of `plant_seed`'s clauses, each one tile state apart from the next. The pack half has its own code and its
    /// own file (<c>PlantSeedStaleSlotTests</c>); these are the tile half, which shared one code.
    /// </summary>
    [Theory]
    [InlineData("seed_not_owned_in_pack", "seed_not_owned_in_pack")]
    [InlineData("soil_not_tilled", "seed_target_unavailable")]
    [InlineData("soil_is_indoor_pot", "seed_target_unavailable")]
    [InlineData("soil_has_crop", "seed_target_unavailable")]
    public void APlantSeedRefusalNamesItsClause(string clause, string code)
    {
        using var world = TargetFamilyWorld.Create();
        world.StandAt(TileX - 1, TileY);
        switch (clause)
        {
            case "soil_is_indoor_pot":
                world.PutInPackSlot(0, ParsnipSeeds, 5, StardewValley.Object.SeedsCategory);
                world.PlaceEmptyHoeDirt(TileX, TileY);
                world.PlaceIndoorPot(TileX, TileY);
                break;
            case "soil_has_crop":
                world.PutInPackSlot(0, ParsnipSeeds, 5, StardewValley.Object.SeedsCategory);
                world.PlaceWaterableCrop(TileX, TileY);
                break;
            case "soil_not_tilled":
                world.PutInPackSlot(0, ParsnipSeeds, 5, StardewValley.Object.SeedsCategory);
                break;
        }

        LocalExecutionReceipt receipt = Plant(world, $"{clause}");

        receipt.State.Should().Be(ExecutionState.Rejected, $"the gate refuses before the walk (evidence: {receipt.Evidence})");
        receipt.ReasonCode.Should().Be(code);
        NamesItsClause(receipt, clause);
    }

    /// <summary>
    /// THE SEED CLAUSE IS BEHIND `Data/Crops` AND CANNOT ANSWER IN THIS PROCESS. `HoeDirt.canPlantThisSeedHere` resolves
    /// the seed through `Crop.TryGetData` -> `Game1.cropData`, which a process without content never loads - so either
    /// the read refuses the request itself (the exception half) or it answers `seed_rejected_by_soil` for every seed.
    /// Both outcomes are the harness's own vocabulary; neither is a pass by default.
    /// </summary>
    [Fact]
    public void TheSeedRejectedBySoilClauseIsBehindAContentReadThisProcessCannotMake()
    {
        using var world = TargetFamilyWorld.Create();
        world.StandAt(TileX - 1, TileY);
        world.PutInPackSlot(0, ParsnipSeeds, 5, StardewValley.Object.SeedsCategory);
        world.PlaceEmptyHoeDirt(TileX, TileY);

        (LocalExecutionReceipt? receipt, string nativeThrow) = ReceiptOrNativeThrow(
            () => Plant(world, "seed_rejected_by_soil"));

        if (receipt is null)
        {
            nativeThrow.Should().BeOneOf(
                new[] { "NullReferenceException", "KeyNotFoundException", "InvalidOperationException", "ContentLoadException" },
                "the clause asks `HoeDirt.canPlantThisSeedHere`, which resolves `Data/Crops`; this process loads none");
            return;
        }

        receipt.ReasonCode.Should().Be("seed_target_unavailable");
        receipt.Evidence.Should().Contain("reason=seed_rejected_by_soil");
    }

    /// <summary>
    /// AND THE IDENTITY CLAUSE SITS BEHIND THAT ONE. A wrong target id on a tilled, empty tile cannot answer
    /// <c>target_id_changed</c> here, because the soil clause above refuses first - so what this row asserts is the
    /// ORDER: the id is the last question, never the first answer.
    /// </summary>
    [Fact]
    public void TheSeedTargetIdentityClauseIsUnmeasuredHereBecauseTheSoilClauseAnswersFirst()
    {
        using var world = TargetFamilyWorld.Create();
        world.StandAt(TileX - 1, TileY);
        world.PutInPackSlot(0, ParsnipSeeds, 5, StardewValley.Object.SeedsCategory);
        world.PlaceEmptyHoeDirt(TileX, TileY);

        (LocalExecutionReceipt? receipt, string nativeThrow) = ReceiptOrNativeThrow(
            () => Plant(world, "target_id_changed", targetId: "seed_not_the_tile_this_is"));

        if (receipt is null)
        {
            nativeThrow.Should().NotBeEmpty("the content read threw, which is the harness limit this row states");
            return;
        }

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.Evidence.Should().NotContain(
            "reason=target_id_changed",
            "the identity is asked after the soil, so a tile whose soil cannot be asked never reaches it - the day this "
                + "process loads Data/Crops this row goes red and becomes a behaviour case");
        receipt.Evidence.Should().Contain("reason=seed_rejected_by_soil", "the clause that does answer is the soil's");
    }

    // ---- water_crop ---------------------------------------------------------------------------------------------

    [Theory]
    [InlineData("soil_not_tilled", "crop_target_unavailable")]
    [InlineData("no_crop", "crop_target_unavailable")]
    [InlineData("crop_needs_no_water", "crop_target_unavailable")]
    [InlineData("crop_already_watered", "crop_target_unavailable")]
    public void AWaterCropRefusalNamesItsClause(string clause, string code)
    {
        using var world = TargetFamilyWorld.Create();
        world.StandAt(TileX - 1, TileY);
        string targetId = $"{clause}_target";
        switch (clause)
        {
            case "no_crop":
                world.PlaceEmptyHoeDirt(TileX, TileY);
                break;
            case "crop_needs_no_water":
                world.PlaceHarvestableCrop(TileX, TileY);
                break;
            case "crop_already_watered":
                world.PlaceWaterableCrop(TileX, TileY).state.Value = 1;
                break;
        }

        LocalExecutionReceipt receipt = world.NewExecutionManager("water_crop")
            .RequestLocalWaterCrop($"req_water_{clause}", TileX, TileY, targetId, 0, Deadline());

        receipt.State.Should().Be(ExecutionState.Rejected, $"the gate refuses before the walk (evidence: {receipt.Evidence})");
        receipt.ReasonCode.Should().Be(code);
        NamesItsClause(receipt, clause);
    }

    /// <summary>
    /// A STATED ID THAT NO LONGER MATCHES IS STILL REFUSED, AND ITS CODE CARRIES BOTH IDS. The two are apart on purpose:
    /// `crop_target_unavailable` above says the tile cannot be watered, while this says the crop standing there is not the
    /// one the request named - and the caller's repair is to look again rather than to retry the address. The identity is
    /// asked LAST, after the tile's own clauses, so this row needs a tile that passes all of them.
    /// </summary>
    [Fact]
    public void AWaterCropRefusalOnAChangedIdentityNamesBothIds()
    {
        const string Stated = "crop_not_the_one_the_tile_holds";
        using var world = TargetFamilyWorld.Create();
        world.StandAt(TileX - 1, TileY);
        world.PlaceWaterableCrop(TileX, TileY);

        LocalExecutionReceipt receipt = world.NewExecutionManager("water_crop")
            .RequestLocalWaterCrop("req_water_target_id_changed", TileX, TileY, Stated, 0, Deadline());

        receipt.State.Should().Be(ExecutionState.Rejected, $"the gate refuses before the walk (evidence: {receipt.Evidence})");
        receipt.ReasonCode.Should().StartWith(
            $"water_crop_target_changed:{Stated}:",
            "the code names the identity that was asked for and the one the tile holds");
        NamesItsClause(receipt, "target_id_changed");
    }

    // ---- harvest_crop -------------------------------------------------------------------------------------------

    [Theory]
    [InlineData("soil_not_tilled", "harvest_target_unavailable")]
    [InlineData("no_crop", "harvest_target_unavailable")]
    [InlineData("crop_is_forage", "harvest_target_unavailable")]
    [InlineData("crop_not_ready", "harvest_target_unavailable")]
    [InlineData("harvest_method_not_grab", "harvest_target_unavailable")]
    public void AHarvestCropRefusalNamesItsClause(string clause, string code)
    {
        using var world = TargetFamilyWorld.Create();
        world.StandAt(TileX - 1, TileY);
        string targetId = $"{clause}_target";
        switch (clause)
        {
            case "no_crop":
                world.PlaceEmptyHoeDirt(TileX, TileY);
                break;
            case "crop_is_forage":
                world.PlaceHarvestableCrop(TileX, TileY).crop.forageCrop.Value = true;
                break;
            case "crop_not_ready":
                world.PlaceWaterableCrop(TileX, TileY);
                break;
            case "harvest_method_not_grab":
                world.PlaceCropWithData(TileX, TileY, ScytheCropSeed, raised: false, fullyGrown: true);
                Game1.cropData![ScytheCropSeed].HarvestMethod = StardewValley.GameData.Crops.HarvestMethod.Scythe;
                break;
        }

        LocalExecutionReceipt receipt = world.NewExecutionManager("harvest_crop")
            .RequestLocalHarvestCrop($"req_harvest_{clause}", TileX, TileY, "(O)24", targetId, Deadline());

        receipt.State.Should().Be(ExecutionState.Rejected, $"the gate refuses before the walk (evidence: {receipt.Evidence})");
        receipt.ReasonCode.Should().Be(code);
        NamesItsClause(receipt, clause);
    }

    /// <summary>
    /// THE SAME TWO SIDES AS `water_crop`: a stated id names a particular crop, and a tile holding another one answers
    /// `<action>_target_changed:<expected>:<found>` rather than the unavailable code, because the tile IS harvestable and
    /// the crop in it is simply not the one the request meant.
    /// </summary>
    [Fact]
    public void AHarvestCropRefusalOnAChangedIdentityNamesBothIds()
    {
        const string Stated = "crop_not_the_one_the_tile_holds";
        using var world = TargetFamilyWorld.Create();
        world.StandAt(TileX - 1, TileY);
        world.PlaceHarvestableCrop(TileX, TileY);

        LocalExecutionReceipt receipt = world.NewExecutionManager("harvest_crop")
            .RequestLocalHarvestCrop("req_harvest_target_id_changed", TileX, TileY, "(O)24", Stated, Deadline());

        receipt.State.Should().Be(ExecutionState.Rejected, $"the gate refuses before the walk (evidence: {receipt.Evidence})");
        receipt.ReasonCode.Should().StartWith(
            $"harvest_crop_target_changed:{Stated}:",
            "the code names the identity that was asked for and the one the tile holds");
        NamesItsClause(receipt, "target_id_changed");
    }

    // ---- fertilize_tile -----------------------------------------------------------------------------------------

    [Theory]
    [InlineData("fertilizer_not_owned_in_slot", "fertilizer_not_owned_in_slot")]
    [InlineData("soil_not_tilled", "fertilizer_target_unavailable")]
    [InlineData("soil_is_indoor_pot", "fertilizer_target_unavailable")]
    [InlineData("fertilizer_rejected_by_soil", "fertilizer_target_unavailable")]
    [InlineData("target_id_changed", "fertilizer_target_unavailable")]
    public void AFertilizeTileRefusalNamesItsClause(string clause, string code)
    {
        using var world = TargetFamilyWorld.Create();
        world.StandAt(TileX - 1, TileY);
        string targetId = $"{clause}_target";
        switch (clause)
        {
            case "soil_not_tilled":
            case "fertilizer_not_owned_in_slot":
                break;
            case "soil_is_indoor_pot":
                world.PlaceEmptyHoeDirt(TileX, TileY);
                world.PlaceIndoorPot(TileX, TileY);
                break;
            case "fertilizer_rejected_by_soil":
                world.PlaceEmptyHoeDirt(TileX, TileY).fertilizer.Value = OtherFertilizer;
                break;
            case "target_id_changed":
                world.PlaceEmptyHoeDirt(TileX, TileY);
                break;
        }

        if (clause != "fertilizer_not_owned_in_slot")
            world.PutInPackSlot(0, Fertilizer, 1, StardewValley.Object.fertilizerCategory);

        LocalExecutionReceipt receipt = world.NewExecutionManager("fertilize_tile")
            .RequestLocalFertilizeTile($"req_fertilize_{clause}", 0, TileX, TileY, Fertilizer, targetId, Deadline());

        receipt.State.Should().Be(ExecutionState.Rejected, $"the gate refuses before the walk (evidence: {receipt.Evidence})");
        receipt.ReasonCode.Should().Be(code);
        NamesItsClause(receipt, clause);
    }

    // ---- bait_crab_pot ------------------------------------------------------------------------------------------

    [Theory]
    [InlineData("bait_not_owned_in_slot", "bait_not_owned_in_slot")]
    [InlineData("pot_not_present", "bait_crab_pot_target_unavailable")]
    [InlineData("not_a_crab_pot", "bait_crab_pot_target_unavailable")]
    [InlineData("pot_not_owned", "bait_crab_pot_target_unavailable")]
    [InlineData("pot_already_baited", "bait_crab_pot_target_unavailable")]
    [InlineData("target_id_changed", "bait_crab_pot_target_unavailable")]
    public void ABaitCrabPotRefusalNamesItsClause(string clause, string code)
    {
        using var world = TargetFamilyWorld.Create();
        world.StandAt(TileX - 1, TileY);
        string targetId = $"{clause}_target";
        switch (clause)
        {
            case "not_a_crab_pot":
                world.PlaceObjectAt(TileX, TileY, PlainObject, "Stone", StardewValley.Object.mineralsCategory);
                break;
            case "pot_not_owned":
                world.PlaceCrabPot(TileX, TileY, bait: null, output: null).owner.Value = 0;
                break;
            case "pot_already_baited":
                world.PlaceCrabPot(TileX, TileY, bait: Bait, output: null);
                break;
            case "target_id_changed":
                world.PlaceCrabPot(TileX, TileY, bait: null, output: null);
                break;
        }

        if (clause != "bait_not_owned_in_slot")
            world.PutBaitInPackSlot(0, Bait, 1);

        LocalExecutionReceipt receipt = world.NewExecutionManager("bait_crab_pot")
            .RequestLocalBaitCrabPot($"req_bait_{clause}", 0, TileX, TileY, Bait, targetId, Deadline());

        receipt.State.Should().Be(ExecutionState.Rejected, $"the gate refuses before the walk (evidence: {receipt.Evidence})");
        receipt.ReasonCode.Should().Be(code);
        NamesItsClause(receipt, clause);
    }

    // ---- machine_inspect ----------------------------------------------------------------------------------------

    /// <summary>
    /// `machine_inspect`'s presence clause, which needs no content: a tile with nothing on it.
    /// </summary>
    [Fact]
    public void AMachineInspectRefusalOnAnEmptyTileNamesItsClause()
    {
        using var world = TargetFamilyWorld.Create();
        world.StandAt(TileX - 1, TileY);

        LocalExecutionReceipt receipt = world.NewExecutionManager("machine_inspect")
            .RequestLocalInspectMachine("req_machine_absent", TileX, TileY, "machine_absent_target", Deadline());

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("machine_target_changed");
        receipt.Evidence.Should().Contain("reason=machine_not_present", "an empty tile is not a machine, and says which way it is not");
    }

    /// <summary>
    /// `GetMachineData()` reads `Data/Machines` (`DataLoader.Machines(Game1.content)`), and this process loads no
    /// content, so the two clauses behind it - "the object there is not a machine" and "it is not the machine the
    /// request named" - cannot answer here. What this row asserts is that the read is what stops them.
    /// </summary>
    [Fact]
    public void TheNotAMachineClauseIsBehindAMachineReadThisProcessCannotMake()
    {
        using var world = TargetFamilyWorld.Create();
        world.StandAt(TileX - 1, TileY);
        world.PlaceObjectAt(TileX, TileY, PlainObject, "Stone", StardewValley.Object.mineralsCategory);

        (LocalExecutionReceipt? receipt, string nativeThrow) = ReceiptOrNativeThrow(
            () => world.NewExecutionManager("machine_inspect")
                .RequestLocalInspectMachine("req_machine_stone", TileX, TileY, "machine_stone_target", Deadline()));

        if (receipt is null)
        {
            nativeThrow.Should().BeOneOf(
                new[] { "NullReferenceException", "KeyNotFoundException", "InvalidOperationException", "ContentLoadException" },
                "the clause asks `Object.GetMachineData()`, which reads `Data/Machines`; this process loads none");
            return;
        }

        receipt.ReasonCode.Should().Be("machine_target_changed");
        receipt.Evidence.Should().Contain(
            "reason=not_a_machine",
            "when the machine table CAN be read, a stone is an object with no machine data and the clause says so");
    }

    /// <summary>
    /// The identity clause behind that read, stated as the ordering it is: a wrong id cannot answer while the machine
    /// read cannot answer.
    /// </summary>
    [Fact]
    public void TheMachineIdentityClauseIsUnmeasuredHereBecauseTheMachineReadAnswersFirst()
    {
        using var world = TargetFamilyWorld.Create();
        world.StandAt(TileX - 1, TileY);
        world.PlaceObjectAt(TileX, TileY, PlainObject, "Stone", StardewValley.Object.mineralsCategory);

        (LocalExecutionReceipt? receipt, string nativeThrow) = ReceiptOrNativeThrow(
            () => world.NewExecutionManager("machine_inspect")
                .RequestLocalInspectMachine("req_machine_wrong_id", TileX, TileY, "machine_not_the_tile_this_is", Deadline()));

        if (receipt is null)
        {
            nativeThrow.Should().NotBeEmpty("the machine read threw, which is the harness limit this row states");
            return;
        }

        receipt.Evidence.Should().NotContain(
            "reason=target_id_changed",
            "the identity is asked after the machine read, so a tile whose object cannot be asked about never reaches it - "
                + "the day this process loads Data/Machines this row goes red and becomes a behaviour case");
        receipt.Evidence.Should().Contain("reason=not_a_machine", "the clause that does answer is the machine read's");
    }

    // ---- helpers ------------------------------------------------------------------------------------------------

    private const string ScytheCropSeed = "gb_tile_target_clause_scythe";

    /// <summary>
    /// THE REFUSAL NAMES ITS CLAUSE, either as the code itself when that code names exactly one fact
    /// (<c>seed_not_owned_in_pack</c>), or as <c>reason=&lt;clause&gt;</c> when the code covers several
    /// (<c>seed_target_unavailable</c>). Both put the fact in one place; what is not allowed is a code covering six
    /// facts that names none of them.
    /// </summary>
    private static void NamesItsClause(LocalExecutionReceipt receipt, string clause) =>
        (receipt.ReasonCode == clause || receipt.Evidence?.Contains($"reason={clause}", StringComparison.Ordinal) == true)
            .Should().BeTrue($"the refusal must name the clause that answered it, as its own code or as reason={clause} (code: {receipt.ReasonCode}; evidence: {receipt.Evidence})");

    private static LocalExecutionReceipt Plant(TargetFamilyWorld world, string clause, string? targetId = null) =>
        world.NewExecutionManager("plant_seed").RequestLocalPlantSeed(
            $"req_seed_{clause}",
            0,
            TileX,
            TileY,
            ParsnipSeeds,
            targetId ?? ExecutionManager.BuildSeedTargetId(world.Farm, TileX, TileY, ParsnipSeeds),
            Deadline());

    /// <summary>
    /// A request that got past its gate either produces a receipt or throws from inside a content read. Both are the
    /// harness's own vocabulary (the same pair <c>NativeRefusalReachabilityTests</c> reads) and neither is a verdict on
    /// the product, so the caller decides what each half means for the clause it is asking about.
    /// </summary>
    private static (LocalExecutionReceipt? Receipt, string NativeThrow) ReceiptOrNativeThrow(Func<LocalExecutionReceipt> request)
    {
        try
        {
            return (request(), string.Empty);
        }
        catch (Exception exception) when (exception is NullReferenceException or InvalidOperationException
            or System.Collections.Generic.KeyNotFoundException
            or Microsoft.Xna.Framework.Content.ContentLoadException)
        {
            return (null, exception.GetType().Name);
        }
    }

    private static long Deadline() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000;
}
