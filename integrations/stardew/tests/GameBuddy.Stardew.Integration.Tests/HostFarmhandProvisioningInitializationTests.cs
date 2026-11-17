using System.Globalization;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Serialization;
using FluentAssertions;
using GameBuddy.Stardew;
using Netcode;
using StardewValley;
using StardewValley.Locations;
using StardewValley.Network;
using StardewValley.SDKs;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// THE BINDING ANSWER FOR A FARMHAND THE SAVE ALREADY OWNS.
///
/// <para>
/// The defect: <c>HostFarmhandProvisioner.HandleRequest</c> initialized the Farmhand it had just created through
/// <c>Cabin.CreateFarmhand()</c>, and refused an existing uncustomized one with <c>farmhand_not_initialized</c> before
/// attempting anything. So a save whose Cabin was created by a run that did not finish initializing could never bind:
/// every later request named the identity the Cabin already owned and was refused on the precondition. These tests drive
/// the seam that decides (the same <c>PrepareTargetFarmhand</c> <c>HandleRequest</c> calls) against a headless world
/// built from the engine's own types. The initialization itself is now the ENGINE'S OWN (`SaveGame.loadDataToFarmer`,
/// `SaveGame.cs:1325`), and that method cannot run in a headless process: it builds a `FarmerRenderer` out of
/// `Game1.content`, and this process has loaded no content. So the fixture drives what it can - the profile seam
/// (`WriteCompanionProfile`, the four writes the engine's OK branch performs), the refusal when the initialization cannot
/// run, and the rollback - and the other half is pinned by `FarmhandConstructionInitializationGateTests`, which requires
/// every Farmhand this Mod constructs to be handed to the engine's initialization.
/// </para>
/// <para>
/// WHAT IS NOT MEASURED HERE, SAID PLAINLY. The request handler's host-state gate sits above this seam and requires a
/// running native LAN server (<c>NativeLanEndpoint.TryRead</c>) plus SMAPI world readiness, so the final response state
/// <c>awaiting_save</c> is not produced by this fixture: <c>live: not measured</c>. The runner that does produce it is
/// <c>dotnet test integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests -c Release --filter
/// FullyQualifiedName~HostFarmhandProvisioningInitializationTests</c> for this seam, and the Player Host live run for the
/// response file itself.
/// </para>
/// </summary>
[Collection(HeadlessGameWorld.Collection)]
public sealed class HostFarmhandProvisioningInitializationTests : IDisposable
{
    private const long HostId = 1001;
    private const long FarmhandId = 2002;

    private static readonly FieldInfo SdkField = typeof(StardewValley.Program)
        .GetField("_sdk", BindingFlags.NonPublic | BindingFlags.Static)!;

    private static readonly FieldInfo PlayerField = typeof(Game1)
        .GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!;

    private static readonly FieldInfo WorldStateField = typeof(Game1)
        .GetField("netWorldState", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)!;

    private readonly Dictionary<string, object?> staticsBefore;
    private readonly object? sdkBefore;
    private readonly object provisioner;

    public HostFarmhandProvisioningInitializationTests()
    {
        this.staticsBefore = HeadlessGameWorld.CaptureStatics();
        this.sdkBefore = SdkField.GetValue(null);

        Game1.game1 = (Game1)FormatterServices.GetUninitializedObject(typeof(Game1));
        var worldState = (NetRoot<NetWorldState>)FormatterServices.GetUninitializedObject(typeof(NetRoot<NetWorldState>));
        worldState.Value = new NetWorldState();
        WorldStateField.SetValue(null, worldState);
        // `Farmer.isActive()` reads this dictionary, and it is assigned during game startup - so an uninitialized
        // `Game1` leaves it null and every `getAllFarmhands()` walk would throw instead of answering "offline".
        Game1.otherFarmers ??= new NetRootDictionary<long, Farmer>();
        PlayerField.SetValue(null, SeedHost());

        this.provisioner = RuntimeHelpers.GetUninitializedObject(typeof(HostFarmhandProvisioner));
        SetField(this.provisioner, "monitor", new DummyMonitor());
        SetField(this.provisioner, "config", new HostFarmhandProvisioningConfig { SessionToken = new string('a', 16) });
        SetField(this.provisioner, "sessionDirectory", Path.GetTempPath());
        SetField(this.provisioner, "sessionNonce", "session_01");
    }

    public void Dispose()
    {
        SdkField.SetValue(null, this.sdkBefore);
        HeadlessGameWorld.RestoreStatics(this.staticsBefore);
    }

    /// <summary>
    /// THE PROFILE SEAM. The Cabin already owns this Farmhand and nobody has customized it: the four writes the engine's
    /// own customization performs are made by the one method that owns them, and the Farmhand the Cabin owns is the
    /// Farmhand that carries them.
    /// </summary>
    [Fact]
    public void AnOwnedUncustomizedFarmhand_GetsTheProfileTheEngineCustomizationWrites()
    {
        Farmer farmhand = this.NewFarmhand(customized: false);
        Cabin cabin = CabinOwning(farmhand);
        this.UseSdk(throws: false);

        InvokeWith(this.provisioner, "WriteCompanionProfile", farmhand);

        farmhand.isCustomized.Value.Should().BeTrue(
            "the initializer is the one the created path uses, and `isCustomized` is what the native client needs");
        farmhand.Name.Should().Be("GameBuddy", "the profile is the companion's, from the Host's own config");
        farmhand.displayName.Should().Be("GameBuddy");
        farmhand.favoriteThing.Value.Should().Be("GameBuddy");
        cabin.OwnerId.Should().Be(FarmhandId, "the identity is repaired in place, never replaced");
        PendingCreatedFarmhandId(this.provisioner).Should().Be(0,
            "nothing was created, so the save-timeout and generic-failure paths have nothing of theirs to delete");
    }

    /// <summary>
    /// The falsifier for the binding path: the initialization cannot run. In this process it cannot, for the reason the
    /// engine's own initialization always fails here - `SaveGame.loadDataToFarmer` needs the loaded content
    /// (`Game1.content` -> `new FarmerRenderer`) that no headless process has - so this is the real failure shape and not
    /// a synthetic one. The refusal must be the initialization's own code - never the not-initialized name the pre-fix
    /// code used - and the Farmhand the save already owned must survive it.
    /// </summary>
    [Fact]
    public void WhenTheInitializationCannotRun_TheRefusalIsNamedAndTheIdentityIsLeftAlone()
    {
        Farmer farmhand = this.NewFarmhand(customized: false);
        Cabin cabin = CabinOwning(farmhand);
        this.UseSdk(throws: false);

        (Farmer? target, bool created, string refusal) = Prepare(this.provisioner, cabin, NativeId(FarmhandId));

        refusal.Should().Be("farmhand_profile_initialization_failed", "an attempt that threw is exactly what this code names");
        target.Should().BeNull();
        created.Should().BeFalse();
        farmhand.isCustomized.Value.Should().BeFalse("the attempt failed before it wrote the profile");
        cabin.OwnerId.Should().Be(FarmhandId,
            "a Farmhand that existed before the request is never deleted by the request's failure");
        PendingCreatedFarmhandId(this.provisioner).Should().Be(0);

        // Every path that rolls a CREATED Farmhand back - save timeout, save write failure, a thrown request, returning
        // to title - runs this method. With nothing tracked it must not touch the identity the save already had.
        Invoke(this.provisioner, "RollbackCreatedFarmhand");
        cabin.OwnerId.Should().Be(FarmhandId, "the rollback owns only what it created");
        Game1.netWorldState.Value.farmhandData.ContainsKey(FarmhandId).Should().BeTrue(
            "the identity the save already had is still the save's");
    }

    /// <summary>
    /// The other half of the rollback discipline, so the previous test cannot pass by the rollback being dead: a
    /// Farmhand this Host DID create is deleted, and the tracking is cleared with it.
    /// </summary>
    [Fact]
    public void TheRollbackDeletesTheFarmhandThisHostCreated_AndOnlyThatOne()
    {
        Farmer farmhand = this.NewFarmhand(customized: true);
        Cabin cabin = CabinOwning(farmhand);

        Invoke(this.provisioner, "RollbackCreatedFarmhand");
        cabin.OwnerId.Should().Be(FarmhandId, "nothing is tracked, so nothing is deleted");

        SetField(this.provisioner, "pendingCreatedCabin", cabin);
        SetField(this.provisioner, "pendingCreatedFarmhandId", FarmhandId);
        Invoke(this.provisioner, "RollbackCreatedFarmhand");

        cabin.OwnerId.Should().Be(0, "the created Farmhand is released through the engine's own Cabin.DeleteFarmhand");
        Game1.netWorldState.Value.farmhandData.ContainsKey(FarmhandId).Should().BeFalse(
            "the created Farmhand was released through the engine's own FarmerTeam.DeleteFarmhand");
        PendingCreatedFarmhandId(this.provisioner).Should().Be(0);
    }

    // ---- the fixture ---------------------------------------------------------

    private void UseSdk(bool throws) => SdkField.SetValue(null, new InitializingSdkHelper(throws));

    private Farmer NewFarmhand(bool customized)
    {
        Farmer farmhand = SeedFarmer(FarmhandId, customized ? "Ada" : string.Empty, customized);
        // `Cabin.owner` resolves through `NetFarmerRef.Value` -> `Game1.getAllFarmers()`, so the Farmhand has to be in
        // the world's own farmhand table - exactly where `Cabin.CreateFarmhand` puts it.
        Game1.netWorldState.Value.farmhandData[FarmhandId] = farmhand;
        return farmhand;
    }

    private static Cabin CabinOwning(Farmer farmhand)
    {
        var cabin = (Cabin)FormatterServices.GetUninitializedObject(typeof(Cabin));
        SetInstanceField(cabin, "farmhandReference", new NetFarmerRef { Value = farmhand });
        return cabin;
    }

    private static Farmer SeedHost()
    {
        Farmer host = SeedFarmer(HostId, "Player", customized: true);
        // `FarmerTeam`'s own constructor registers a sprite definition with `Game1.content` (PlayerStatusList), so the
        // team is uninitialized and given the one field `FarmerTeam.DeleteFarmhand` writes through.
        var team = (FarmerTeam)FormatterServices.GetUninitializedObject(typeof(FarmerTeam));
        SetInstanceField(team, "friendshipData", new NetFarmerPairDictionary<Friendship, NetRef<Friendship>>());
        SetInstanceField(host, "teamRoot", new NetRoot<FarmerTeam> { Value = team });
        return host;
    }

    private static Farmer SeedFarmer(long id, string name, bool customized)
    {
        var farmer = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
        SetInstanceField(farmer, "name", new NetString(name));
        farmer.displayName = name;
        SetInstanceField(farmer, "uniqueMultiplayerID", new NetLong(id));
        SetInstanceField(farmer, "isCustomized", new NetBool(customized));
        SetInstanceField(farmer, "favoriteThing", new NetString(string.Empty));
        SetInstanceField(farmer, "userID", new NetString(string.Empty));
        // `-1` is the engine's own "no override" for both, so `ConvertClothingOverrideToClothesItems` reads no item data
        // this process never loads.
        SetInstanceField(farmer, "pants", new NetString("-1"));
        SetInstanceField(farmer, "shirt", new NetString("-1"));
        return farmer;
    }

    private static string NativeId(long id) => id.ToString(CultureInfo.InvariantCulture);

    private static (Farmer? Farmhand, bool Created, string Refusal) Prepare(object provisioner, Cabin cabin, string expectedFarmhandId)
    {
        object target = typeof(HostFarmhandProvisioner)
            .GetMethod("PrepareTargetFarmhand", BindingFlags.Instance | BindingFlags.NonPublic)!
            .Invoke(provisioner, new object?[] { cabin, expectedFarmhandId })!;
        Type type = target.GetType();
        return (
            (Farmer?)type.GetProperty("Farmhand")!.GetValue(target),
            (bool)type.GetProperty("Created")!.GetValue(target)!,
            (string)type.GetProperty("RefusalReason")!.GetValue(target)!);
    }

    private static long PendingCreatedFarmhandId(object provisioner) =>
        (long)typeof(HostFarmhandProvisioner)
            .GetField("pendingCreatedFarmhandId", BindingFlags.Instance | BindingFlags.NonPublic)!
            .GetValue(provisioner)!;

    private static void Invoke(object provisioner, string name) =>
        typeof(HostFarmhandProvisioner)
            .GetMethod(name, BindingFlags.Instance | BindingFlags.NonPublic, null, Type.EmptyTypes, null)!
            .Invoke(provisioner, null);

    private static void InvokeWith(object provisioner, string name, params object?[] arguments) =>
        typeof(HostFarmhandProvisioner)
            .GetMethod(name, BindingFlags.Instance | BindingFlags.NonPublic, null, new[] { typeof(Farmer) }, null)!
            .Invoke(provisioner, arguments);

    private static void SetField(object instance, string name, object? value) =>
        typeof(HostFarmhandProvisioner)
            .GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!
            .SetValue(instance, value);

    private static void SetInstanceField(object instance, string name, object? value) =>
        instance.GetType()
            .GetField(name, BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
            .SetValue(instance, value);

    /// <summary>
    /// The one platform boundary <c>Utility.FilterDirtyWords</c> reads: <c>Program.sdk</c>, an interface over the
    /// Steam/GOG/GDK helper. A process with no platform is `NullSDKHelper`'s case (it returns the words unchanged), and
    /// this double adds the one thing these tests need - being told to fail - so the initializer's own failure path is
    /// forced rather than hoped for.
    /// </summary>
    private sealed class InitializingSdkHelper : SDKHelper
    {
        private readonly bool throws;

        internal InitializingSdkHelper(bool throws) => this.throws = throws;

        public bool IsEnterButtonAssignmentFlipped => false;

        public bool IsJapaneseRegionRelease => false;

        public string Name => "test";

        public SDKNetHelper Networking => null!;

        public bool ConnectionFinished => true;

        public int ConnectionProgress => 0;

        public bool HasOverlay => false;

        public void EarlyInitialize()
        {
        }

        public void Initialize()
        {
        }

        public void Update()
        {
        }

        public void Shutdown()
        {
        }

        public void DebugInfo()
        {
        }

        public bool RetroactiveAchievementsAllowed() => true;

        public void GetAchievement(string achieve)
        {
        }

        public void ResetAchievements()
        {
        }

        public string FilterDirtyWords(string words) =>
            this.throws ? throw new InvalidOperationException("sdk_unavailable") : words;
    }
}
