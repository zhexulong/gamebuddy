using System;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Models;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Network;
using StardewValley.Tools;
using Xunit;
using static GameBuddy.Stardew.Integration.Tests.TargetFamilyCompletenessTests;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// ONE charged tool use covers the engine's own footprint IN THE WORLD, with the tier coming from the fixture rather than
/// from a number typed into the assertion.
///
/// <para>
/// THE MEASUREMENT THIS CLOSES. The area work (`charge` on `till_soil`/`water_crop`) shipped with its coverage asserted
/// against synthetic tools, and every recorded run held level-0 tools: all 64 bundles carrying `toolSlots` report
/// `upgradeLevel: 0`, so `RefuseToolCharge` answered `charge_exceeds_tool_upgrade:4:0` and one native use could only ever
/// cover one tile. A capability no run can reach is decoration.
/// </para>
///
/// <para>
/// WHAT IS REAL HERE. The tool is the one the fixture grants: an uninitialized <see cref="Hoe"/> whose NetFields this
/// world seeds, raised through the Mod's own <c>SetFixtureToolUpgradeLevel</c> - the same write
/// <c>native_gold_tools_v1</c> performs before bridge attachment. The level is then read back by the SHIPPED
/// <c>DiscoverToolSlots</c> that fills <c>snapshot.toolSlots[].upgradeLevel</c>, and by the engine's own
/// <c>Tool.tilesAffected</c> when <c>Hoe.DoFunction</c> runs. The receipt is the production <c>ExecutionManager</c>'s, and
/// <c>tiles_changed</c> is counted from two reads of the world either side of the swing - so "nine" is measured, never
/// restated from the charge.
/// </para>
///
/// <para>
/// THE TWO PROCESS FACTS, declared rather than simulated away. The tool is an uninitialized instance, so
/// <c>Tool.PlayUseSounds</c> is false and the engine's two <c>playSound</c> calls are skipped - this process has no audio
/// device. And a tool swing's soil puff is built from `Data`-loaded textures through <see cref="Game1.content"/> and
/// broadcast through <see cref="Game1.multiplayer"/>; <see cref="ToolSwingProcessScope"/> supplies exactly those two and
/// restores them, which is a double at a boundary this process does not own (the asset and network pipelines) rather
/// than at any seam of the product.
/// </para>
///
/// <para>
/// WHAT IS NOT PROVEN HERE: the Hold path a live player's mouse drives (`Game1.pressUseToolButton` raising `toolPower`
/// over time). The charge is written to <c>who.toolPower</c> exactly as production's <c>UseNativeToolOnTile</c> writes it,
/// so what is proven is the footprint one charged use covers, not the input gesture that asks for one.
/// </para>
/// </summary>
[Collection(HeadlessGameWorld.Collection)]
public sealed class GoldToolAreaCoverageTests
{
    /// <summary>The named tile one charged use is aimed at.</summary>
    private const int TargetX = 8;
    private const int TargetY = 8;

    /// <summary>
    /// The chain the fixture's scenario exists for: the level the fixture writes is the level the snapshot publishes.
    ///
    /// <para>
    /// Asked of ONE tool on purpose. A fixture that set a level the projection never read would make every live run look
    /// upgraded while the plan still saw 0 - the shape this test is here to make impossible.
    /// </para>
    /// </summary>
    [Fact]
    public void TheLevelTheFixtureGrantsIsTheLevelTheSnapshotPublishes()
    {
        using var world = TargetFamilyWorld.Create();
        world.PutToolInPackSlot(0, typeof(Hoe), "(T)Hoe", upgradeLevel: 0);

        Tool hoe = RaiseThroughTheFixture(world.Actor.Items[0]!, upgradeLevel: 3);

        // The PUBLISHED level is asserted first, because that is the claim the fixture exists for: a tool whose tier was
        // written but never read would make every live run plan a basic tool while the actor swings a gold one.
        BridgeToolSlot published = world.Rows("toolSlots").Cast<BridgeToolSlot>().Should().ContainSingle().Subject;
        published.Slot.Should().Be(0);
        published.Category.Should().Be("hoe", "the word `till_soil`'s own `tool:hoe` claim uses");
        published.UpgradeLevel.Should().Be(
            3,
            "`snapshot.toolSlots[].upgradeLevel` is read from the tool the engine will swing, so a fixture-granted tier must arrive here");
        hoe.UpgradeLevel.Should().Be(3, "the fixture writes the tool's own tier, and reads it back before it returns");
    }

    /// <summary>
    /// A gold hoe, asked for `charge: 3`, tills the engine's 3x3 - nine tiles, counted in the world.
    ///
    /// <para>
    /// The charge ladder is the engine's own (<c>Tool.tilesAffected</c>: 1 tile at 0, 1x3 at 1, 1x5 at 2, 3x3 at 3), and
    /// the ceiling the request must respect is the held tool's level (<c>Game1.cs:13032-13051</c>). Nine is therefore the
    /// footprint ONE use covers at gold, and it is asserted twice from independent readings: the receipt's own
    /// before/after measurement, and a fresh scan of the farm the receipt left behind.
    /// </para>
    /// </summary>
    [Fact]
    public void OneChargedGoldHoeUseTillsTheEnginesNineTileFootprint()
    {
        using var world = TargetFamilyWorld.Create();
        // The Given: the actor owns a hoe, and nine tiles of native diggable ground in front of where it stands. The TIER
        // is the fixture's grant, never a value this test writes.
        world.PutToolInPackSlot(0, typeof(Hoe), "(T)Hoe", upgradeLevel: 0);
        RaiseThroughTheFixture(world.Actor.Items[0]!, upgradeLevel: 3);
        world.StandAt(TargetX, TargetY - 1);
        for (int x = TargetX - 1; x <= TargetX + 1; x++)
        {
            for (int y = TargetY; y <= TargetY + 2; y++)
                world.MakeDiggable(x, y);
        }
        // DRY WEATHER, stated as the world fact it is. `Hoe.DoFunction` asks `makeHoeDirt`, which asks `IsRainingHere()`
        // (GameLocation.cs:14244), and an unknown context makes `NetWorldState.GetWeatherForLocation` GENERATE that day's
        // weather - which reads `Data/Festivals` through `Game1.temporaryContent` (NetWorldState.cs:841-850). One row
        // saying "not raining" is the state a real save carries and keeps the question away from a content pipeline this
        // process does not have.
        Game1.netWorldState.Value!.LocationWeather["Default"] = new StardewValley.Network.LocationWeather();

        LocalExecutionReceipt receipt;
        using (ToolSwingProcessScope.Create())
        {
            receipt = world.NewExecutionManager("till_soil").RequestLocalTillSoil(
                "req_gold_hoe",
                TargetX,
                TargetY,
                charge: 3,
                requestedDeadlineMs: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000);
        }

        receipt.State.Should().Be(ExecutionState.Succeeded, receipt.Evidence);
        receipt.ReasonCode.Should().Be("soil_tilled");
        // The asked-for charge and the applied one are the same integer by construction, so this pair is the receipt's own
        // proof that nothing was silently clamped down to a footprint the request did not name.
        receipt.Evidence.Should().Contain("charge_requested=3").And.Contain("charge_applied=3");
        receipt.Evidence.Should().Contain("tiles_changed=9");

        Vector2[] tilled = world.Farm.terrainFeatures.Pairs
            .Where(pair => pair.Value is StardewValley.TerrainFeatures.HoeDirt)
            .Select(pair => pair.Key)
            .ToArray();
        tilled.Should().HaveCount(9, "one charged use left exactly the engine's 3x3 behind it");
        for (int x = TargetX - 1; x <= TargetX + 1; x++)
        {
            for (int y = TargetY; y <= TargetY + 2; y++)
            {
                tilled.Should().Contain(new Vector2(x, y), "the footprint is the 3x3 the actor faces, tile by tile");
            }
        }

        world.Farm.GetHoeDirtAtTile(new Vector2(TargetX, TargetY)).Should().NotBeNull(
            "the NAMED tile is the completion condition; the other eight are the footprint it was measured through");
    }

    /// <summary>
    /// The fixture's own tier write, driven through the Mod rather than restated here: a second implementation of "make
    /// this tool gold" would agree with the fixture today and disagree with it the first time either one moved.
    /// </summary>
    private static Tool RaiseThroughTheFixture(Item item, int upgradeLevel)
    {
        item.Should().BeAssignableTo<Tool>("the fixture raises tools, which is what the pack slot holds");
        MethodInfo setLevel = typeof(ModEntry)
            .GetMethod("SetFixtureToolUpgradeLevel", BindingFlags.NonPublic | BindingFlags.Static)!;
        return (Tool)setLevel.Invoke(null, new object?[] { item, upgradeLevel })!;
    }

    /// <summary>
    /// The two engine statics a native tool swing dereferences and this process does not have, supplied for the duration
    /// of one swing and put back afterwards.
    ///
    /// <para>
    /// <c>Hoe.DoFunction</c> ends every tilled tile in <c>Game1.multiplayer.broadcastSprites</c> with a sprite built from
    /// `TileSheets\animations`; <c>Multiplayer.broadcastSprites</c> itself only appends to the location's temporary
    /// sprite list and returns while <c>Game1.IsMultiplayer</c> is false (Multiplayer.cs:460-466), and the sprite's
    /// texture is the one thing a content manager is asked for - neither is read by the tilling path, so the doubles
    /// answer only what this process cannot.
    /// </para>
    /// </summary>
    private sealed class ToolSwingProcessScope : IDisposable
    {
        private static readonly FieldInfo MultiplayerField =
            typeof(Game1).GetField("multiplayer", BindingFlags.Static | BindingFlags.NonPublic)!;

        private static readonly FieldInfo ContentField =
            typeof(Game1).GetField("content", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)!;

        private static readonly FieldInfo LocationDataField =
            typeof(Game1).GetField("locationData", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)!;

        private readonly object? multiplayerBefore;
        private readonly object? contentBefore;
        private readonly object? locationDataBefore;

        private ToolSwingProcessScope()
        {
            this.multiplayerBefore = MultiplayerField.GetValue(null);
            this.contentBefore = ContentField.GetValue(null);
            this.locationDataBefore = LocationDataField.GetValue(null);
        }

        internal static ToolSwingProcessScope Create()
        {
            var scope = new ToolSwingProcessScope();
            MultiplayerField.SetValue(null, FormatterServices.GetUninitializedObject(typeof(Multiplayer)));
            ContentField.SetValue(null, FormatterServices.GetUninitializedObject(typeof(NoContentManager)));
            // The ONE `Data/Locations` lookup a tilled tile makes: `Hoe.DoFunction` ends each tile in
            // `checkForBuriedItem`, whose first line is `GetData()` (GameLocation.cs:15211) - an EMPTY table is the honest
            // value for a process that loaded no locations, and every row the engine would read from it is optional.
            // Created as the concrete table the engine's own `Game1.locationData` is, keyed ordinally like every other
            // engine data table, so a later read by name compares the way the game's does.
            LocationDataField.SetValue(null, new System.Collections.Generic.Dictionary<string, StardewValley.GameData.Locations.LocationData>(StringComparer.Ordinal));
            return scope;
        }

        public void Dispose()
        {
            MultiplayerField.SetValue(null, this.multiplayerBefore);
            ContentField.SetValue(null, this.contentBefore);
            LocationDataField.SetValue(null, this.locationDataBefore);
        }
    }

    /// <summary>
    /// The engine's asset lookup, answering nothing: the only thing a swing's cosmetic sprite asks it for is a texture
    /// this process has no graphics device to load.
    /// </summary>
    private sealed class NoContentManager : LocalizedContentManager
    {
        /// <summary>
        /// Declared only so the type can exist: this instance is never constructed, it is an uninitialized object whose
        /// one overridden method is all anyone calls.
        /// </summary>
        private NoContentManager()
            : base(null!, "Content")
        {
        }

        public override T Load<T>(string assetName) => default!;
    }
}
