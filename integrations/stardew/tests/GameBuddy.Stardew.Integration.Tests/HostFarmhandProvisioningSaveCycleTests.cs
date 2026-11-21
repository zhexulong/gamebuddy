using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Serialization;
using FluentAssertions;
using GameBuddy.Stardew;
using Netcode;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Locations;
using StardewValley.Network;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// THE SAVE CYCLE'S SIDE OF AN ENTRY: what the engine owes, and what the next launch reads.
///
/// <para>
/// A companion enters on the in-memory record - the Farmhand the Cabin owns, its profile, this world's identity - and
/// the binding that record names is written by the engine's own <c>Saving</c>, not by the attach. So there are three
/// shapes to state, and this file states each with a fixture: the save lands (<c>TheEnginesSaveCycleWrites...</c>), the
/// session ends before any save (<c>ASessionThatNeverSaves...</c>), and the save runs but the Mod's own write throws
/// (<c>AWriteThatFails...</c>).
/// </para>
/// <para>
/// WHY THE FIXTURE FILLS THE OBLIGATION INSTEAD OF CALLING THE ATTACH. The attach path's host-state gate sits above
/// this seam and requires a running native LAN server plus SMAPI world readiness, so a headless process cannot produce
/// the <c>ready</c> answer that fills the obligation; the gate that pins the answer itself is
/// <c>EntryDoesNotWaitForTheEngineSaveSourceShapeTests</c>, and the live Player Host run is the response file. What is
/// measurable here is the half this change is about: the write rides <c>OnSaving</c>, and every outcome leaves the
/// world's own identity alone.
/// </para>
/// </summary>
[Collection(HeadlessGameWorld.Collection)]
public sealed class HostFarmhandProvisioningSaveCycleTests : IDisposable
{
    private const long HostId = 1001;
    private const long FarmhandId = 2002;
    private const string CompanionId = "companion_01";
    private const string CabinId = "cabin_01";
    private const string RequestId = "request_01";

    private static readonly FieldInfo SdkField = typeof(StardewValley.Program)
        .GetField("_sdk", BindingFlags.NonPublic | BindingFlags.Static)!;

    private static readonly FieldInfo PlayerField = typeof(Game1)
        .GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!;

    private static readonly FieldInfo WorldStateField = typeof(Game1)
        .GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!;

    /// <summary>
    /// The <c>PerScreen&lt;bool&gt;</c> SMAPI answers <c>Context.IsWorldReady</c> from. It has no setter: the property's
    /// own getter names the field, and the fixture writes it through the type's <c>SetValueForScreen</c>.
    /// </summary>
    private static readonly FieldInfo WorldReadyPerScreen = typeof(Context)
        .GetProperty("IsWorldReady", BindingFlags.Public | BindingFlags.Static)!
        .GetGetMethod()!
        .Module.ResolveField(BitConverter.ToInt32(typeof(Context)
            .GetProperty("IsWorldReady", BindingFlags.Public | BindingFlags.Static)!
            .GetGetMethod()!.GetMethodBody()!.GetILAsByteArray()!, 1))!;

    private readonly Dictionary<string, object?> staticsBefore;
    private readonly byte multiplayerModeBefore;
    private readonly SaveCycleWorld world;

    public HostFarmhandProvisioningSaveCycleTests()
    {
        this.staticsBefore = HeadlessGameWorld.CaptureStatics();
        this.multiplayerModeBefore = Game1.multiplayerMode;
        this.world = SaveCycleWorld.Create();
    }

    public void Dispose()
    {
        this.world.Dispose();
        Game1.multiplayerMode = this.multiplayerModeBefore;
        HeadlessGameWorld.RestoreStatics(this.staticsBefore);
    }

    /// <summary>
    /// THE SAVE LANDS. The binding a companion entered on is in the store after the engine's own <c>Saving</c>, with
    /// the request id its replay index needs, and the obligation is retired - the write is owed once, not every save.
    /// </summary>
    [Fact]
    public void TheEnginesSaveCycleWritesTheBindingACompanionEnteredOn()
    {
        Expect(this.world.Provisioner, Owed());

        this.world.Invoke("OnSaving");

        FarmhandBindingStore written = this.world.Data.Written!;
        written.Should().NotBeNull("the engine's Saving ran and the obligation was owed, so the store must carry it");
        FarmhandBinding binding = written.Bindings.Should().ContainSingle().Subject;
        binding.CompanionId.Should().Be(CompanionId);
        binding.FarmhandId.Should().Be(FarmhandId);
        binding.CabinId.Should().Be(CabinId);
        written.ConsumedRequestIds.Should().Contain(RequestId, "a replayed request must not be answered twice after a relaunch");
        Owed(this.world.Provisioner).Should().BeEmpty("the write is owed once; the next save has nothing to write");
        IsQuarantined(this.world.Provisioner).Should().BeFalse();
    }

    /// <summary>
    /// THE SAVE NEVER COMES. Nothing reaches the store, and the Farmhand the companion entered on is still the Cabin's
    /// owner: entry does not depend on the write, so the write's absence cannot take the entry back. The next launch
    /// reads a save with no binding for this Cabin and provisions it again.
    /// </summary>
    [Fact]
    public void ASessionThatNeverSaves_RecordsNothingAndKeepsTheFarmhand()
    {
        Expect(this.world.Provisioner, Owed());

        // No OnSaving: the player played and quit, and Stardew only saves when the day ends.
        this.world.Data.Written.Should().BeNull("no save cycle ran, so nothing was recorded for the next launch");
        Owed(this.world.Provisioner).Should().ContainSingle("the write is still owed, because no save has carried it");
        this.world.Cabin.OwnerId.Should().Be(FarmhandId, "the identity the companion entered on is the world's, not the write's");
        Game1.netWorldState.Value.farmhandData.ContainsKey(FarmhandId).Should().BeTrue("the identity the companion entered on is still the world's");
        IsQuarantined(this.world.Provisioner).Should().BeFalse();
    }

    /// <summary>
    /// THE RECORD IS THE REQUEST ID ALONE when the store already held the binding: a re-attach to a Cabin that was
    /// bound in an earlier session owes the save nothing but its replay index.
    /// </summary>
    [Fact]
    public void ABindingTheStoreAlreadyHolds_OwesOnlyItsRequestId()
    {
        Expect(this.world.Provisioner, new HostFarmhandProvisioner.PendingSaveBinding(Request(), null));

        this.world.Invoke("OnSaving");

        FarmhandBindingStore written = this.world.Data.Written!;
        written.Bindings.Should().BeEmpty("the store already held this companion's binding and the entry did not mint another");
        written.ConsumedRequestIds.Should().Contain(RequestId);
    }

    /// <summary>
    /// THE SAVE RUNS AND THE MOD'S WRITE THROWS. What is lost is the record, never the session: the Farmhand stays in
    /// the world the companion is playing in - the engine is mid-save, and an identity that was admitted is not a
    /// leftover of a creation attempt - and provisioning is quarantined rather than left half-written.
    /// </summary>
    [Fact]
    public void AWriteThatFails_KeepsTheFarmhandAndQuarantinesTheSurface()
    {
        Expect(this.world.Provisioner, Owed());
        this.world.Data.Throws = true;

        this.world.Invoke("OnSaving");

        this.world.Data.WriteAttempts.Should().Be(1);
        IsQuarantined(this.world.Provisioner).Should().BeTrue();
        Collection(this.world.Provisioner, "bindingsOwedToTheNextSave").Should().BeEmpty(
            "a write that throws leaves the save request armed, and the save it opens is the engine's own: retrying it on every cycle would be a save loop");
        this.world.Cabin.OwnerId.Should().Be(FarmhandId, "the Farmhand the companion is playing as is not deleted because a record could not be written");
        Game1.netWorldState.Value.farmhandData.ContainsKey(FarmhandId).Should().BeTrue("the identity the companion entered on is still the world's");
    }

    /// <summary>
    /// A session that returns to the title screen owes nothing to a world that no longer exists, and the next launch
    /// reads the save on disk.
    /// </summary>
    [Fact]
    public void ReturningToTheTitleScreen_ForgetsTheObligation()
    {
        Expect(this.world.Provisioner, Owed());

        this.world.Invoke("OnReturnedToTitle");

        Owed(this.world.Provisioner).Should().BeEmpty();
        this.world.Data.WriteAttempts.Should().Be(0, "the write belongs to a save cycle, and a world that ended has none");
    }

    // ---- the fixture ---------------------------------------------------------

    private static HostFarmhandProvisioner.PendingSaveBinding Owed() =>
        new(Request(), new FarmhandBinding
        {
            CompanionId = CompanionId,
            FarmhandId = FarmhandId,
            CabinId = CabinId,
            SaveId = "save_01",
            WorldId = "world_01",
            BoundAtUnixMs = 1_700_000_000_000,
        });

    private static FarmhandAttachmentRequest Request() => new()
    {
        RequestId = RequestId,
        CompanionId = CompanionId,
        CabinId = CabinId,
        SaveId = "save_01",
        WorldId = "world_01",
    };

    private static void Expect(object provisioner, params HostFarmhandProvisioner.PendingSaveBinding[] owed) =>
        typeof(HostFarmhandProvisioner)
            .GetField("bindingsOwedToTheNextSave", BindingFlags.Instance | BindingFlags.NonPublic)!
            .SetValue(provisioner, owed.ToList());

    private static IReadOnlyList<HostFarmhandProvisioner.PendingSaveBinding> Owed(object provisioner) =>
        Collection(provisioner, "bindingsOwedToTheNextSave").ToArray();

    private static List<HostFarmhandProvisioner.PendingSaveBinding> Collection(object provisioner, string name) =>
        (List<HostFarmhandProvisioner.PendingSaveBinding>)(typeof(HostFarmhandProvisioner)
            .GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!
            .GetValue(provisioner) ?? new List<HostFarmhandProvisioner.PendingSaveBinding>());

    private static bool IsQuarantined(object provisioner) =>
        (bool)typeof(HostFarmhandProvisioner).GetField("quarantined", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(provisioner)!;

    /// <summary>
    /// A world with a Cabin that owns its Farmhand, the <c>Game1</c> statics <c>Context.IsWorldReady</c> and
    /// <c>Game1.IsMasterGame</c> dereference, and a provisioner whose only platform boundary - SMAPI's save data - is a
    /// recording double. The double is the boundary, not the subject: what is asserted is what the Mod's own
    /// <c>OnSaving</c> hands it.
    /// </summary>
    private sealed class SaveCycleWorld : IDisposable
    {
        private readonly Dictionary<string, object?> staticsBefore;
        private readonly object? sdkBefore;
        private readonly byte multiplayerModeBefore;

        internal object Provisioner { get; }

        internal RecordingSaveData Data { get; }

        internal Cabin Cabin { get; }

        private SaveCycleWorld()
        {
            this.staticsBefore = HeadlessGameWorld.CaptureStatics();
            this.sdkBefore = SdkField.GetValue(null);
            // `Game1.multiplayerMode` is what `IsMasterGame` answers from (Game1.cs:1808-1818), and a headless process has
            // no mode of its own: zero is single player, which is the host this surface writes save data for.
            this.multiplayerModeBefore = Game1.multiplayerMode;
            Game1.multiplayerMode = 0;

            Game1.game1 = (Game1)FormatterServices.GetUninitializedObject(typeof(Game1));
            var worldState = (NetRoot<NetWorldState>)FormatterServices.GetUninitializedObject(typeof(NetRoot<NetWorldState>));
            worldState.Value = new NetWorldState();
            WorldStateField.SetValue(null, worldState);
            // `Farmer.isActive()` reads this dictionary, and it is assigned during game startup.
            Game1.otherFarmers ??= new NetRootDictionary<long, Farmer>();
            PlayerField.SetValue(null, SeedHost());

            var data = DispatchProxy.Create<IDataHelper, RecordingSaveData>();
            this.Data = (RecordingSaveData)(object)data;
            var helper = DispatchProxy.Create<IModHelper, ModHelperProxy>();
            ((ModHelperProxy)(object)helper).Data = data;

            string directory = Path.Combine(Path.GetTempPath(), $"gamebuddy-save-cycle-{Guid.NewGuid():N}");
            Directory.CreateDirectory(directory);
            object provisioner = RuntimeHelpers.GetUninitializedObject(typeof(HostFarmhandProvisioner));
            SetField(provisioner, "monitor", new DummyMonitor());
            SetField(provisioner, "config", new HostFarmhandProvisioningConfig { SessionToken = new string('a', 16) });
            SetField(provisioner, "sessionDirectory", directory);
            SetField(provisioner, "sessionNonce", "session_01");
            SetField(provisioner, "helper", helper);
            this.Provisioner = provisioner;

            Farmer farmhand = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
            SetInstanceField(farmhand, "name", new NetString("GameBuddy"));
            farmhand.displayName = "GameBuddy";
            SetInstanceField(farmhand, "uniqueMultiplayerID", new NetLong(FarmhandId));
            SetInstanceField(farmhand, "isCustomized", new NetBool(true));
            SetInstanceField(farmhand, "favoriteThing", new NetString("GameBuddy"));
            SetInstanceField(farmhand, "userID", new NetString(string.Empty));
            Game1.netWorldState.Value.farmhandData[FarmhandId] = farmhand;
            var cabin = (Cabin)FormatterServices.GetUninitializedObject(typeof(Cabin));
            SetInstanceField(cabin, "farmhandReference", new NetFarmerRef { Value = farmhand });
            this.Cabin = cabin;

            WorldReadyPerScreen.GetValue(null)!.GetType()
                .GetMethod("SetValueForScreen", new[] { typeof(int), typeof(bool) })!
                .Invoke(WorldReadyPerScreen.GetValue(null), new object[] { Context.ScreenId, true });
            Context.IsWorldReady.Should().BeTrue("the headless world must satisfy the readiness gate OnSaving checks");
            Game1.IsMasterGame.Should().BeTrue("a save cycle is the host's, and this fixture is the host");
        }

        internal static SaveCycleWorld Create() => new();

        /// <summary>The Mod's own save-cycle handler, and the private body it calls, by the names they are declared with.</summary>
        internal void Invoke(string name) =>
            typeof(HostFarmhandProvisioner)
                .GetMethod(name, BindingFlags.Instance | BindingFlags.NonPublic)!
                .Invoke(this.Provisioner, null);

        public void Dispose()
        {
            foreach (string file in Directory.Exists((string)typeof(HostFarmhandProvisioner)
                .GetField("sessionDirectory", BindingFlags.Instance | BindingFlags.NonPublic)!
                .GetValue(this.Provisioner)!)
                ? Directory.GetFiles((string)typeof(HostFarmhandProvisioner)
                    .GetField("sessionDirectory", BindingFlags.Instance | BindingFlags.NonPublic)!
                    .GetValue(this.Provisioner)!)
                : Array.Empty<string>())
            {
                File.Delete(file);
            }
            Directory.Delete((string)typeof(HostFarmhandProvisioner)
                .GetField("sessionDirectory", BindingFlags.Instance | BindingFlags.NonPublic)!
                .GetValue(this.Provisioner)!, recursive: true);
            SdkField.SetValue(null, this.sdkBefore);
            Game1.multiplayerMode = this.multiplayerModeBefore;
            WorldReadyPerScreen.GetValue(null)!.GetType().GetMethod("ResetAllScreens", Type.EmptyTypes)!.Invoke(WorldReadyPerScreen.GetValue(null), null);
            HeadlessGameWorld.RestoreStatics(this.staticsBefore);
        }

        private static Farmer SeedHost()
        {
            var host = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
            SetInstanceField(host, "name", new NetString("Player"));
            host.displayName = "Player";
            SetInstanceField(host, "uniqueMultiplayerID", new NetLong(HostId));
            SetInstanceField(host, "isCustomized", new NetBool(true));
            SetInstanceField(host, "favoriteThing", new NetString(string.Empty));
            SetInstanceField(host, "userID", new NetString(string.Empty));
            // `FarmerTeam`'s own constructor registers a sprite definition with `Game1.content` (PlayerStatusList), so the
            // team is uninitialized and given the one field `FarmerTeam.DeleteFarmhand` writes through.
            var team = (FarmerTeam)FormatterServices.GetUninitializedObject(typeof(FarmerTeam));
            SetInstanceField(team, "friendshipData", new NetFarmerPairDictionary<Friendship, NetRef<Friendship>>());
            SetInstanceField(host, "teamRoot", new NetRoot<FarmerTeam> { Value = team });
            return host;
        }

        private static void SetField(object instance, string name, object? value) =>
            typeof(HostFarmhandProvisioner)
                .GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(instance, value);

        private static void SetInstanceField(object instance, string name, object? value) =>
            instance.GetType()
                .GetField(name, BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
                .SetValue(instance, value);
    }

    private class ModHelperProxy : DispatchProxy
    {
        internal IDataHelper Data { get; set; } = null!;

        protected override object? Invoke(MethodInfo? targetMethod, object?[]? args) =>
            targetMethod?.Name == "get_Data" ? this.Data : throw new NotSupportedException(targetMethod?.Name);
    }

    /// <summary>
    /// SMAPI's save data, and the only double in this file: it is a boundary the Mod does not own. A read answers what
    /// the last write carried, as a copy - so a test that passes proves the write carried the binding, not that an
    /// object was handed around in memory.
    /// </summary>
    private class RecordingSaveData : DispatchProxy
    {
        internal FarmhandBindingStore? Written { get; private set; }

        internal int WriteAttempts { get; private set; }

        internal bool Throws { get; set; }

        protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
        {
            switch (targetMethod?.Name)
            {
                case "ReadSaveData":
                    return this.Written is null
                        ? new FarmhandBindingStore()
                        : new FarmhandBindingStore
                        {
                            Bindings = this.Written.Bindings
                                .Select(binding => new FarmhandBinding
                                {
                                    CompanionId = binding.CompanionId,
                                    FarmhandId = binding.FarmhandId,
                                    CabinId = binding.CabinId,
                                    SaveId = binding.SaveId,
                                    WorldId = binding.WorldId,
                                    BoundAtUnixMs = binding.BoundAtUnixMs,
                                })
                                .ToList(),
                            ConsumedRequestIds = this.Written.ConsumedRequestIds.ToList(),
                        };
                case "WriteSaveData":
                    this.WriteAttempts++;
                    if (this.Throws)
                        throw new IOException("simulated_write_failure");
                    this.Written = (FarmhandBindingStore)args![1]!;
                    return null;
                default:
                    throw new NotSupportedException(targetMethod?.Name);
            }
        }
    }
}
