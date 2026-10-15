using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    private void InitializeNativeMachineInspectFixture(StardewValley.Farm farm, StardewValley.AnimalHouse[] houses)
    {
        // SetupBigFarm owns the original target-version construction and
        // native Object initialization. Select a machine it produced;
        // never call a machine interaction, load/collect path, or edit
        // held output/input/timers. Inspection will only reread this
        // state through the production bridge after attachment.
        // SetupBigFarm lays Kegs in the native 3..14 × 36..44 grid.
        // Choose a perimeter Keg whose adjacent outside grid tile is
        // demonstrably walkable, so fixture navigation never guesses
        // through a dense machine cluster.
        KeyValuePair<Vector2, StardewValley.Object> machinePair = farm.objects.Pairs
            .Where(pair => pair.Value.QualifiedItemId == "(BC)12" && pair.Value.GetMachineData() is not null)
            .OrderBy(pair => pair.Key.X)
            .ThenBy(pair => pair.Key.Y)
            .FirstOrDefault(pair => new[]
            {
                pair.Key + new Vector2(-1f, 0f),
                pair.Key + new Vector2(1f, 0f),
                pair.Key + new Vector2(0f, -1f),
                pair.Key + new Vector2(0f, 1f)
            }.Any(tile => farm.isTilePassable(tile)
                && farm.CanItemBePlacedHere(tile, itemIsPassable: true, CollisionMask.All, CollisionMask.None)));
        if (machinePair.Value is null)
            throw new InvalidOperationException("fixture_native_machine_missing");
        StardewValley.Object machine = machinePair.Value;
        if (machine.GetMachineData() is null)
            throw new InvalidOperationException("fixture_native_machine_data_missing");
        Vector2[] approachTiles = new[]
        {
            machinePair.Key + new Vector2(-1f, 0f),
            machinePair.Key + new Vector2(1f, 0f),
            machinePair.Key + new Vector2(0f, -1f),
            machinePair.Key + new Vector2(0f, 1f)
        };
        Vector2[] validApproaches = approachTiles
            .Where(tile => farm.isTilePassable(tile)
                && farm.CanItemBePlacedHere(tile, itemIsPassable: true, CollisionMask.All, CollisionMask.None)
                && (tile.X < 3f || tile.X > 14f || tile.Y < 36f || tile.Y > 44f))
            .ToArray();
        if (validApproaches.Length == 0)
            throw new InvalidOperationException("fixture_native_machine_approach_missing");
        Vector2 approach = validApproaches[0];
        this.hostAutomationFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy HostAutomation initialized native machine-inspect v1 fixture before attachment: animal_houses={houses.Length}; Cabin retained; machine={machine.QualifiedItemId}@{(int)machinePair.Key.X},{(int)machinePair.Key.Y}; approach={(int)approach.X},{(int)approach.Y}; ready={machine.readyForHarvest.Value}; minutes_until_ready={machine.MinutesUntilReady}; held={machine.heldObject.Value?.QualifiedItemId ?? "none"}; last_input={machine.lastInputItem.Value?.QualifiedItemId ?? "none"}; a native save/reload plus production bridge reread are still required.", LogLevel.Info);
    }
}
