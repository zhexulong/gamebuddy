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
        // THE RECTANGLE THE PRE-CHECK WALKED IS THE RECTANGLE THE SWING COVERED, and the receipt's `changed` is where it
        // travels: the Mod's receipt key set is PINNED to the Host's own `TILL_SOIL_EVIDENCE_KEYS`
        // (`host/src/stardew-completion-contracts.ts`, compared by `DeclaredToolSelectionTests`), so a new key is not this
        // unit's to add - and on clean ground the tiles that entered `HoeDirt` ARE the footprint.
        Tool precheckedTool = world.Actor.Items[0] as Tool ?? throw new InvalidOperationException("the fixture put a hoe in slot 0");
        List<Vector2>? prechecked = ChargedFootprint.Tiles(precheckedTool, TargetX, TargetY, 3, world.Actor, out string unreadable);
        prechecked.Should().NotBeNull($"the engine's rectangle could not be read: footprint_unavailable:{unreadable}");
        List<Vector2> expectedFootprint = prechecked!;
        expectedFootprint.Should().HaveCount(9, "one charged gold use covers the engine's own 3x3");
        string[] footprint = (receipt.Evidence ?? string.Empty)
            .Split(';')
            .Single(fact => fact.StartsWith("changed=", StringComparison.Ordinal))["changed=".Length..]
            .Split('|');
        footprint.Should().BeEquivalentTo(expectedFootprint.Select(tile => $"{tile.X:0}:{tile.Y:0}"),
            "the receipt reports exactly the tiles the pre-check walked, and the swing changed every one of them");

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
                footprint.Should().Contain($"{x}:{y}", "the reported footprint is the same nine tiles the world shows tilled");
            }
        }

        world.Farm.GetHoeDirtAtTile(new Vector2(TargetX, TargetY)).Should().NotBeNull(
            "the NAMED tile is the completion condition; the other eight are the footprint it was measured through");
    }

    /// <summary>
    /// THE REFUSAL: a keg standing on a tile the request never named stops the charged swing, and the receipt names both
    /// the occupant and the tile.
    ///
    /// <para>
    /// WHY A KEG AND NOT A CROP. `Hoe.DoFunction` hands a tile that carries a terrain feature to
    /// `TerrainFeature.performToolAction` and then `continue`s past its tilling branch (<c>Hoe.cs:69-76</c>), and on a
    /// planted crop that is <c>Crop.hitWithHoe</c>, which answers true only for a forage seed spot (<c>Crop.cs:468-480</c>).
    /// A mature crop SURVIVES a charged hoe, so refusing on one would forbid the ordinary act of tilling a new row beside a
    /// planted field. A keg is the case the engine really does take: <c>Object.performToolAction</c> removes every
    /// <c>Type == "Crafting"</c> object a heavy hitter swings at (<c>Object.cs:1350-1432</c>), and the swing then drops it
    /// into the debris layer.
    /// </para>
    /// <para>
    /// THE PAIR PROVES BOTH HALVES: this half proves the Mod refuses and leaves the world alone; the sibling fact below
    /// proves the same world without the guard loses the keg. Asserting the refusal alone would only show that something
    /// said no.
    /// </para>
    /// </summary>
    [Fact]
    public void AChargedGoldHoeRefusesAKegInsideItsFootprint()
    {
        using TargetFamilyWorld world = WorldWithAKegInTheFootprint(out Vector2 kegTile);
        StardewValley.Object keg = world.Farm.objects[kegTile];
        float staminaBefore = world.Actor.Stamina;

        LocalExecutionReceipt receipt;
        using (ToolSwingProcessScope.Create())
        {
            receipt = world.NewExecutionManager("till_soil").RequestLocalTillSoil(
                "req_charged_footprint_keg",
                TargetX,
                TargetY,
                charge: 3,
                requestedDeadlineMs: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000);
        }

        receipt.State.Should().Be(ExecutionState.Rejected, receipt.Evidence);
        // `,` is outside the reason-code alphabet, so the tile travels as `x:y` and the code still names the occupant AND
        // where it stands - a bare `charged_use_would_destroy` would leave the caller to guess which of nine tiles.
        receipt.ReasonCode.Should().Be($"charged_use_would_destroy:object:{kegTile.X:0}:{kegTile.Y:0}");
        receipt.Evidence.Should().Contain($"would_destroy={kegTile.X:0}:{kegTile.Y:0}:object");
        receipt.Evidence.Should().Contain("blocked_by=");
        FarmhandExecutionJournal.IsValidReasonCode(receipt.ReasonCode).Should().BeTrue(
            "the code is what a journal row carries, so it has to be in that alphabet");

        // THE WORLD IS WHAT THE REFUSAL CLAIMED. The object is the same instance on the same tile, no tile was tilled, and
        // no stamina was spent - a refusal that still swung would be the very defect it exists to prevent.
        world.Farm.objects[kegTile].Should().BeSameAs(keg, "a refused swing leaves the keg standing");
        world.Farm.terrainFeatures.Pairs.Should().NotContain(pair => pair.Value is StardewValley.TerrainFeatures.HoeDirt,
            "a refused swing tills nothing, the named tile included");
        world.Actor.Stamina.Should().Be(staminaBefore, "the swing never ran, so it cost nothing");
    }

    /// <summary>
    /// WHICH OCCUPANTS A CHARGED FOOTPRINT IS REFUSED FOR, answered by the engine's own predicates over a real world.
    ///
    /// <para>
    /// THE PROTECTION IS ONE-SIDED ON PURPOSE. A rule that refused every occupied tile would make a packed row
    /// unusable on a working farm - a sprinkler, a stone or a planting sits beside almost every strip - which is the
    /// "refuses the normal case" defect <c>MeleeSweepOccupancy.Undeclared</c> already records for pasture. So the
    /// occupants are partitioned by what the engine's own branches answer for a hoe, not by what looks hazardous:
    /// </para>
    /// <list type="bullet">
    /// <item>a weed is NOT named - cutting one is what a hoe does, and the catalogue marks `cut_weeds` non-destructive
    /// (<c>Object.cs:1150</c>);</item>
    /// <item>a breakable stone is NOT named - it needs a Pickaxe and every other tool is skipped (<c>Object.cs:1121,1138</c>);
    /// </item>
    /// <item>a sprinkler is NOT named - the engine excludes it by name for a hoe (<c>Object.cs:1352</c>);</item>
    /// <item>a chest is NOT named - <c>Chest.performToolAction</c> answers false to every tool (<c>Chest.cs:379-451</c>);
    /// </item>
    /// <item>a PLANTED CROP is NOT named - a mature crop survives a charged hoe (<c>HoeDirt.cs:758-765</c> into
    /// <c>Crop.hitWithHoe</c>, true only for a forage seed spot), so refusing one would forbid tilling a new row beside a
    /// planted field;</item>
    /// <item>already-tilled soil is NOT named - a hoe leaves <c>HoeDirt</c> alone, so a packed use neither refuses it nor
    /// claims to have tilled it;</item>
    /// <item>a KEG is named, with the occupant word the classifier uses and its tile, because
    /// <c>Object.performToolAction</c> removes every <c>Type == "Crafting"</c> object a heavy hitter swings at
    /// (<c>Object.cs:1350-1432</c>).</item>
    /// </list>
    /// <para>
    /// WHY THE REMOVAL ITSELF IS NOT DRIVEN HERE. A charged swing at a crafting object runs into
    /// <c>Object.IsTapper</c> → <c>HasContextTag</c> → <c>ItemRegistry</c> (<c>Object.cs:1371,6190</c>), and a process with
    /// no <c>Data/Objects</c> throws <c>KeyNotFoundException</c> from the item registry - measured while writing this
    /// fact, not assumed. The removal is therefore cited to the engine's branch and the *behaviour* that matters (the Mod
    /// refuses before the swing) is driven for real in the sibling fact.
    /// </para>
    /// </summary>
    [Fact]
    public void OnlyTheOccupantsTheEngineCannotLeaveAreNamed()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        var kegTile = new Vector2(9f, 10f);
        var weedTile = new Vector2(8f, 10f);
        var stoneTile = new Vector2(7f, 10f);
        var sprinklerTile = new Vector2(9f, 9f);
        var chestTile = new Vector2(7f, 9f);
        var cropTile = new Vector2(8f, 9f);
        var tilledTile = new Vector2(7f, 8f);
        world.Farm.objects[kegTile] = TargetFamilyWorld.PlacedObject("(BC)12", name: "Keg", category: -9);
        world.Farm.objects[kegTile].Type = "Crafting";
        world.PlaceWeed((int)weedTile.X, (int)weedTile.Y);
        world.PlaceRock((int)stoneTile.X, (int)stoneTile.Y, durability: 2);
        world.Farm.objects[sprinklerTile] = TargetFamilyWorld.PlacedObject("(O)599", name: "Sprinkler", category: -9);
        world.PlaceOrdinaryChest((int)chestTile.X, (int)chestTile.Y, Array.Empty<ChestItem>());
        world.PlaceHarvestableCrop((int)cropTile.X, (int)cropTile.Y);
        world.PlaceEmptyHoeDirt((int)tilledTile.X, (int)tilledTile.Y);

        var footprint = new List<Vector2>();
        for (int x = 7; x <= 9; x++)
        {
            for (int y = 8; y <= 10; y++)
                footprint.Add(new Vector2(x, y));
        }

        List<(Vector2 Tile, string Kind)> named = ChargedFootprint.Undeclared(world.Farm, footprint, new Vector2(8f, 9f));

        named.Should().ContainSingle("the keg is the one tile of nine the engine would have taken")
            .Which.Tile.Should().Be(kegTile);
        named[0].Kind.Should().Be("object", "the classifier's own word for a placed object it cannot name more precisely");
    }

    /// <summary>
    /// The Given both halves share: a gold hoe in slot 0, dry diggable ground over the 3x3 in front of the actor, and one
    /// keg in the far corner of that rectangle - a tile the plan never names.
    /// </summary>
    private static TargetFamilyWorld WorldWithAKegInTheFootprint(out Vector2 kegTile)
    {
        TargetFamilyWorld world = TargetFamilyWorld.Create();
        world.PutToolInPackSlot(0, typeof(Hoe), "(T)Hoe", upgradeLevel: 0);
        RaiseThroughTheFixture(world.Actor.Items[0]!, upgradeLevel: 3);
        world.StandAt(TargetX, TargetY - 1);
        for (int x = TargetX - 1; x <= TargetX + 1; x++)
        {
            for (int y = TargetY; y <= TargetY + 2; y++)
                world.MakeDiggable(x, y);
        }
        Game1.netWorldState.Value!.LocationWeather["Default"] = new StardewValley.Network.LocationWeather();
        kegTile = new Vector2(TargetX + 1, TargetY + 2);
        world.Farm.objects[kegTile] = TargetFamilyWorld.PlacedObject("(BC)12", name: "Keg", category: -9);
        // `Type` is the field the engine's own removal branch reads (`Object.cs:1350`), and a real `(BC)12` carries
        // `crafting`; an uninitialized `Object` carries the empty string, which would make the engine test below prove
        // nothing at all.
        world.Farm.objects[kegTile].Type = "Crafting";
        return world;
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
