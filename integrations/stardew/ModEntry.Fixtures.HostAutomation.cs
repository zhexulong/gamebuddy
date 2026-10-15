using System;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew;

/// <summary>
/// Where a HostAutomation fixture's own setup runs in the shared native-world
/// sequence. The ordering is real, not cosmetic: a Given that the cleared farm
/// or a running LAN server would invalidate must be established on the raw
/// loaded Farm, and harvest_crop's re-seed must land on the SetupBigFarm world
/// before the shared validation reads the animal houses.
/// </summary>
internal enum HostAutomationFixturePhase
{
    /// <summary>On the raw loaded Farm, before SetupBigFarm.</summary>
    BeforeNativeSetup,

    /// <summary>On the SetupBigFarm world, before the shared farm validation.</summary>
    AfterNativeSetup,

    /// <summary>On the SetupBigFarm world, after the shared animal-house/Cabin validation.</summary>
    AfterSharedValidation,
}

/// <summary>
/// One armable HostAutomation scenario: where its setup runs and what it does.
/// <c>Initialize</c> and <c>PrepareBeforeSharedValidation</c> receive the animal
/// houses the shared validation computed; a phase that runs before it receives none.
/// </summary>
internal sealed record HostAutomationFixtureRegistration(
    HostAutomationFixturePhase Phase,
    Action<ModEntry, Farm, AnimalHouse[]> Initialize,
    bool ArmsAfterNativeLanServer = false,
    Action<ModEntry, Farm, AnimalHouse[]>? PrepareBeforeSharedValidation = null);

public sealed partial class ModEntry
{
    /// <summary>
    /// THE HostAutomation fixture scenario registry. Every scenario this Mod can
    /// arm is named exactly once, and that one name is also its dispatch recipe:
    /// each guard compares the configured scenario name to the literal directly,
    /// because <c>tools/check-stardew-fixture-scenario-wiring.mjs</c> reads that
    /// spelling as the scenario's dispatch block and reports a scenario without
    /// one as <c>armed_without_a_recipe</c>.
    ///
    /// A scenario name must still appear in four places to be armable, and this is
    /// where each of them now lives:
    /// <list type="number">
    /// <item><c>ModConfig.cs</c>: <c>NativeLocalPlayerFixtureConfig.KnownFixtureScenarios</c>
    /// (the native-local config gate). Not derived from this registry.</item>
    /// <item>This registry's guard. This used to be the dispatcher's own
    /// <c>is not (...)</c> allowlist.</item>
    /// <item>This registry's entry - the registration the guard returns. This used to be
    /// the dispatcher's per-scenario block.</item>
    /// <item><c>ModConfig.cs</c>: <c>HostAutomationConfig.IsValid</c>'s inline chain. Not
    /// derived from this registry either.</item>
    /// </list>
    /// Points 2 and 3 are now one line each in one file; points 1 and 4 stay in
    /// <c>ModConfig.cs</c>, so a new scenario must still be added there too.
    /// <c>native_animal_product_v2</c> is the exception: it is HostAutomation-only
    /// (absent from <c>KnownFixtureScenarios</c>), so it is matched with
    /// <c>string.Equals</c> instead of a guard - spelling it as a guard would make
    /// the wiring checker report <c>dispatched_but_config_rejects</c>.
    /// </summary>
    private static HostAutomationFixtureRegistration? ResolveHostAutomationFixtureRegistration(string FixtureScenario)
    {
        if (FixtureScenario == "native_npc_relationship_v1")
            return new(HostAutomationFixturePhase.BeforeNativeSetup, static (mod, farm, _) => mod.InitializeNativeNpcRelationshipFixture(farm));
        if (FixtureScenario == "native_use_item_v1")
            return new(HostAutomationFixturePhase.BeforeNativeSetup, static (mod, farm, _) => mod.InitializeNativeUseItemFixture(farm));
        if (FixtureScenario == "native_farmhand_chat_v1")
            return new(HostAutomationFixturePhase.BeforeNativeSetup, static (mod, _, _) => mod.InitializeNativeFarmhandChatFixture(), ArmsAfterNativeLanServer: true);
        if (FixtureScenario == "native_farmhand_talk_to_npc_v1")
            return new(HostAutomationFixturePhase.BeforeNativeSetup, static (mod, farm, _) => mod.InstallSharedWorldTalkToNpcFixture(farm), ArmsAfterNativeLanServer: true);
        if (FixtureScenario == "native_ship_item_v1")
            return new(HostAutomationFixturePhase.AfterNativeSetup, static (mod, farm, _) => mod.InitializeNativeShipItemFixture(farm));
        if (FixtureScenario == "native_harvest_crop_v1")
            return new(
                HostAutomationFixturePhase.AfterSharedValidation,
                static (mod, farm, _) => mod.InitializeNativeHarvestCropFixture(farm),
                PrepareBeforeSharedValidation: static (mod, farm, _) => mod.PrepareNativeHarvestCropFixture(farm));
        if (FixtureScenario == "native_pickup_forage_v1")
            return new(HostAutomationFixturePhase.AfterSharedValidation, static (mod, farm, _) => mod.InitializeNativePickupForageFixture(farm));
        if (FixtureScenario == "native_pickup_item_v1")
            return new(HostAutomationFixturePhase.AfterSharedValidation, static (mod, farm, _) => mod.InitializeNativePickupItemFixture(farm));
        if (FixtureScenario == "native_chest_retrieve_v1")
            return new(HostAutomationFixturePhase.AfterSharedValidation, static (mod, farm, _) => mod.InitializeNativeChestRetrieveFixture(farm));
        if (FixtureScenario == "native_pet_animal_v1")
            return new(HostAutomationFixturePhase.AfterSharedValidation, static (mod, farm, _) => mod.InitializeNativePetFixture(farm));
        if (FixtureScenario == "native_machine_inspect_v1")
            return new(HostAutomationFixturePhase.AfterSharedValidation, static (mod, farm, houses) => mod.InitializeNativeMachineInspectFixture(farm, houses));
        if (FixtureScenario == "native_till_soil_v1")
            return new(HostAutomationFixturePhase.AfterSharedValidation, static (mod, farm, houses) => mod.InitializeNativeTillSoilFixture(farm, houses));
        if (FixtureScenario == "native_plant_seed_v1")
            return new(HostAutomationFixturePhase.AfterSharedValidation, static (mod, farm, houses) => mod.InitializeNativePlantSeedFixture(farm, houses));
        if (FixtureScenario == "native_water_crop_v1")
            return new(HostAutomationFixturePhase.AfterSharedValidation, static (mod, farm, houses) => mod.InitializeNativeWaterCropFixture(farm, houses));
        if (FixtureScenario == "native_fertilize_tile_v1")
            return new(HostAutomationFixturePhase.AfterSharedValidation, static (mod, farm, houses) => mod.InitializeNativeFertilizeTileFixture(farm, houses));
        if (FixtureScenario == "native_feed_animal_v1")
            return new(HostAutomationFixturePhase.AfterSharedValidation, static (mod, farm, houses) => mod.InitializeNativeFeedAnimalFixture(farm, houses));
        if (string.Equals(FixtureScenario, "native_animal_product_v2", StringComparison.Ordinal))
            return new(HostAutomationFixturePhase.AfterSharedValidation, static (mod, farm, houses) => mod.InitializeNativeAnimalProductFixture(farm, houses));
        return null;
    }

    /// <summary>
    /// Build a disposable native test world before the formal LAN lifecycle.
    /// The target-version debug helper owns building/animal setup; GameBuddy
    /// only fences scope and validates the resulting live facts. This method
    /// never enters a bridge request, calls the tested action, or emits a receipt.
    /// </summary>
    private void TryInitializeNativeFixtureScenario()
    {
        HostAutomationConfig? automation = this.config.HostAutomation;
        if (this.hostAutomationFixtureInitialized || this.hostAutomationTerminal || automation is not { Enable: true })
            return;
        HostAutomationFixtureRegistration? scenario = ResolveHostAutomationFixtureRegistration(automation.FixtureScenario);
        if (scenario is null)
            return;
        // Scenarios that must still arm once the engine's own LAN server is up. The ordering this guard
        // otherwise enforces - "fixture setup runs before a LAN server exists" - is about setups that cannot
        // be established afterwards. Neither exempted scenario is one: the chat scenario mutates nothing, and
        // the shared-world talk scenario establishes WORLD state (a villager's placement and the bound actor's
        // saved location), which a running server does not invalidate. Without the exemption both would be
        // unarmable in the formal topology, because the Mod enables the native LAN host option at session
        // start and the engine starts serving as soon as the world is live - observed live as
        // `multiplayer_gate_topology_failed:host_fixture_readiness` after the world had loaded and the Cabin
        // already existed.
        if (!automation.SaveName.StartsWith("GameBuddyFixture_", StringComparison.Ordinal) || !Context.IsWorldReady || !Game1.IsMasterGame || (!scenario.ArmsAfterNativeLanServer && Game1.server is not null) || this.hostFarmhandProvisioner?.IsAwaitingSave == true)
            return;

        try
        {
            Farm farm = Game1.getFarm();
            if (!farm.buildings.Any(building => building.GetIndoors() is StardewValley.Locations.Cabin))
                throw new InvalidOperationException("fixture_cabin_missing_before_native_setup");

            if (scenario.Phase == HostAutomationFixturePhase.BeforeNativeSetup)
            {
                scenario.Initialize(this, farm, Array.Empty<AnimalHouse>());
                return;
            }

            // SetupBigFarm's target-version ClearFarm clears spawned/object
            // contents only; it retains existing buildings, including Cabin.
            // It uses native Build/AnimalHouse.adoptAnimal/door lifecycle.
            GameLocation? previousLocation = Game1.currentLocation;
            try
            {
                Game1.currentLocation = farm;
                bool invoked = Game1.game1.parseDebugInput("SetupBigFarm", null);
                if (!invoked)
                    throw new InvalidOperationException("fixture_native_debug_command_unavailable");
            }
            finally
            {
                Game1.currentLocation = previousLocation;
            }

            scenario.PrepareBeforeSharedValidation?.Invoke(this, farm, Array.Empty<AnimalHouse>());

            if (scenario.Phase == HostAutomationFixturePhase.AfterNativeSetup)
            {
                scenario.Initialize(this, farm, Array.Empty<AnimalHouse>());
                return;
            }

            AnimalHouse[] houses = farm.buildings
                .Select(building => building.GetIndoors())
                .OfType<AnimalHouse>()
                .ToArray();
            if (houses.Length == 0)
                throw new InvalidOperationException("fixture_native_animal_house_missing");
            if (!farm.buildings.Any(building => building.GetIndoors() is StardewValley.Locations.Cabin))
                throw new InvalidOperationException("fixture_cabin_missing_after_native_setup");

            scenario.Initialize(this, farm, houses);
        }
        catch (Exception exception)
        {
            this.hostAutomationTerminal = true;
            this.PublishFixtureReadiness(automation, "fixture_blocked", FixtureFailureReason(exception));
            this.Monitor.Log($"GameBuddy HostAutomation fixture initializer failed closed: {exception}", LogLevel.Error);
        }
    }

    /// <summary>
    /// Resolve the already-bound AI Farmhand actor of the retained Cabin. Every
    /// HostAutomation scenario uses this exact target-version resolution: the
    /// configured PlayerId must name a Farmer retained in this save who owns the
    /// Cabin the LAN attachment binds to. This method never touches Game1.player,
    /// never starts a server, and never invokes the tested action.
    /// </summary>
    private Farmer ResolveHostAutomationFarmhand(StardewValley.Farm farm)
    {
        long farmhandId = this.ResolveBoundFarmhandId();
        Farmer? farmhand = Game1.GetPlayer(farmhandId, onlyOnline: false);
        bool ownsRetainedCabin = farmhand is not null && farm.buildings
            .Select(building => building.GetIndoors())
            .OfType<StardewValley.Locations.Cabin>()
            .Any(cabin => cabin.OwnerId == farmhandId);
        if (!ownsRetainedCabin || farmhand is null)
            throw new InvalidOperationException("fixture_bound_farmhand_missing_after_native_setup");
        if (farmhand.MaxItems < 36)
            farmhand.increaseBackpackSize(36 - farmhand.MaxItems);
        return farmhand;
    }

    /// <summary>
    /// Resolve the Farm arrival the attached Farmhand will land on from the
    /// retained Cabin's own native warp. This is the same target-version anchor
    /// the other HostAutomation placement helpers use; no map coordinate is
    /// guessed and no actor is warped here.
    /// </summary>
    private static Vector2 ResolveHostAutomationFarmArrival(Farmer farmhand, StardewValley.Farm farm, string reasonCodePrefix)
    {
        StardewValley.Warp? farmWarp = farmhand.currentLocation?.warps
            .FirstOrDefault(warp => !warp.npcOnly.Value && string.Equals(warp.TargetName, farm.Name, StringComparison.Ordinal));
        farmWarp ??= Game1.locations
            .OfType<StardewValley.Locations.Cabin>()
            .SelectMany(cabin => cabin.warps)
            .FirstOrDefault(warp => !warp.npcOnly.Value && string.Equals(warp.TargetName, farm.Name, StringComparison.Ordinal));
        if (farmWarp is null || farmWarp.TargetX < 0 || farmWarp.TargetY < 0)
            throw new InvalidOperationException($"fixture_native_{reasonCodePrefix}_farm_warp_missing");
        return new Vector2(farmWarp.TargetX, farmWarp.TargetY);
    }
}
