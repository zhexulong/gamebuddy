using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Netcode;
using StardewValley;
using StardewValley.Network;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The mailbox's two independent defects, pinned as behaviour on a real farm location
/// rather than as source shape (design/research/perception-discovery-radius.md, W6).
///
/// <para>
/// (1) DISCOVERY WAS BOUND TO THE EXECUTION RADIUS. <c>DiscoverMailboxTargets</c> skipped every
/// candidate outside <c>MailboxClaimReachTiles</c> = 1, so the companion could only see a mailbox
/// it already stood next to and the action was never offered in normal play. The mailbox is a
/// fixed landmark of the farm, exactly like the shipping bin, and
/// <c>DiscoverShippingBinTargets</c> applies no radius at all.
/// </para>
///
/// <para>
/// (2) THE CLAIM HAD NO APPROACH. <c>RequestLocalClaimMailAttachment</c> returned
/// <c>mail_claim_out_of_range</c> for any actor outside that window, where every other tile
/// action in this partial-class set walks in first and re-validates on arrival.
/// </para>
///
/// <para>
/// The three cases below are the acceptance scenario of the lane, in order. Each drives the
/// product's own entry point on a probe farm: the discovery projection, the request path, and
/// the armed approach's arrival. The native letter delivery itself is not re-implemented here --
/// a headless process owns no content manager -- so the arrival case that reaches
/// <c>GameLocation.mailbox()</c> asserts only that every pre-native gate passed and the seam was
/// entered; the delivered attachment stays with the <c>native_claim_mail_attachment_v1</c> gate.
/// </para>
/// </summary>
public sealed class MailboxDiscoveryAndApproachTests
{
    /// <summary>The farm mailbox tile the game itself reports when the map declares none.</summary>
    private const int MailboxTileX = 68;
    private const int MailboxTileY = 16;

    /// <summary>Twenty tiles west of the mailbox: far outside the claim's Chebyshev-1 window.</summary>
    private const int FarTileX = 48;
    private const int FarTileY = 16;

    // ---- (a) discovery is presence-scoped, not reach-scoped --------------------------------

    [Fact]
    public void AMailboxTwentyTilesAway_IsDiscovered_WithItsPendingCount()
    {
        using var harness = MailboxHarness.Create();
        harness.StandAt(FarTileX, FarTileY);
        harness.QueueLetters("probeLetter");

        IReadOnlyList<BridgeMailboxTarget> targets = ExecutionManager.DiscoverMailboxTargets(Game1.player);

        targets.Should().ContainSingle("the farm has one mailbox and it is published from anywhere on the farm");
        BridgeMailboxTarget mailbox = targets[0];
        mailbox.X.Should().Be(MailboxTileX);
        mailbox.Y.Should().Be(MailboxTileY);
        mailbox.Location.Should().Be("Farm");
        mailbox.PendingCount.Should().Be(1, "the count is what makes the target worth acting on");
        mailbox.TargetId.Should().Be(
            ExecutionManager.BuildMailboxTargetId(harness.Farm, MailboxTileX, MailboxTileY, 1, "probeLetter"),
            "discovery and execution name the mailbox through the one identity builder");
    }

    /// <summary>
    /// The same world, two actor tiles: the published target must not depend on where the actor
    /// stands. This is the assertion the old radius filter cannot satisfy for any pair of tiles
    /// further apart than the claim reach, and it is what separates "presence-scoped" from
    /// "a bigger radius".
    /// </summary>
    [Fact]
    public void ThePublishedMailbox_DoesNotMoveWithTheActor()
    {
        using var harness = MailboxHarness.Create();
        harness.QueueLetters("probeLetter");

        harness.StandAt(FarTileX, FarTileY);
        string far = ExecutionManager.DiscoverMailboxTargets(Game1.player).Single().TargetId;

        harness.StandAt(4, 4);
        string elsewhere = ExecutionManager.DiscoverMailboxTargets(Game1.player).Single().TargetId;

        harness.StandAt(MailboxTileX, MailboxTileY + 1);
        string adjacent = ExecutionManager.DiscoverMailboxTargets(Game1.player).Single().TargetId;

        elsewhere.Should().Be(far);
        adjacent.Should().Be(far, "a landmark does not appear or disappear because the companion walked");
    }

    // ---- (b) claiming from outside the reach walks in first --------------------------------

    [Fact]
    public void ClaimingFromTwentyTilesAway_BeginsAnApproach_InsteadOfRefusing()
    {
        using var harness = MailboxHarness.Create();
        harness.StandAt(FarTileX, FarTileY);
        harness.QueueLetters("probeLetter");
        ExecutionManager manager = harness.CreateManager();
        string targetId = harness.PublishedTargetId("probeLetter");

        LocalExecutionReceipt receipt = manager.RequestLocalClaimMailAttachment(
            "req_mail_far", MailboxTileX, MailboxTileY, targetId, harness.DeadlineMs);

        receipt.ReasonCode.Should().NotBe(
            "mail_claim_out_of_range",
            "being far from a mailbox is a walk, not a refusal: every other tile action in this set begins an approach");
        receipt.State.Should().Be(ExecutionState.Accepted);
        receipt.ReasonCode.Should().Be("accepted");
        // The armed walk names where it stands and what it is walking to, so the receipt says the
        // actor is on its way rather than claiming anything happened yet.
        receipt.Evidence.Should().Contain($"tile={MailboxTileX},{MailboxTileY}");
        receipt.Evidence.Should().Contain("reach=1;approach=adjacent");
        receipt.Evidence.Should().Contain($"distance={MailboxTileX - FarTileX}");
        harness.ArmedApproach().Should().NotBeNull("the request path hands the walk to the shared approach leg");
        harness.ArmedApproach()!.TargetX.Should().Be(MailboxTileX);
        harness.ArmedApproach()!.TargetY.Should().Be(MailboxTileY);
        harness.ArmedApproach()!.ActionId.Should().Be("claim_mail_attachment");
        harness.QueueLetters("probeLetter");
        Game1.mailbox.Should().ContainSingle("a walk claims nothing: the letter is still waiting");
    }

    /// <summary>
    /// The arrival runs the claim, not a distance check: every gate that does not need the letter's
    /// content passes and the native seam is entered. Its evidence names the letter it was about to
    /// claim, which only the path below the reach/empty/identity gates produces.
    /// </summary>
    [Fact]
    public void TheArrivalAtTheMailbox_EntersTheNativeClaim()
    {
        using var harness = MailboxHarness.Create();
        harness.StandAt(FarTileX, FarTileY);
        harness.QueueLetters("probeLetter");
        ExecutionManager manager = harness.CreateManager();
        string targetId = harness.PublishedTargetId("probeLetter");

        manager.RequestLocalClaimMailAttachment("req_mail_arrive", MailboxTileX, MailboxTileY, targetId, harness.DeadlineMs);
        harness.StandAt(MailboxTileX - 1, MailboxTileY);

        LocalExecutionReceipt arrival = harness.RunArrival(manager, "req_mail_arrive");

        arrival.ReasonCode.Should().NotBe("mail_claim_out_of_range", "the actor arrived inside the native claim reach");
        arrival.ReasonCode.Should().NotBe("mailbox_empty");
        arrival.ReasonCode.Should().NotBe("mail_target_changed");
        arrival.Evidence.Should().Contain(
            "mail_id=probeLetter",
            "the claim was resolved far enough to name its head letter, so only the native delivery is left to the live gate");
    }

    // ---- (c) the arrival re-validates the identity the walk was planned against -------------

    [Fact]
    public void ALetterTakenDuringTheWalk_IsRefusedOnArrival_AndTheNextLetterIsNotOpened()
    {
        using var harness = MailboxHarness.Create();
        harness.StandAt(FarTileX, FarTileY);
        harness.QueueLetters("letterA", "letterB");
        ExecutionManager manager = harness.CreateManager();
        string targetId = harness.PublishedTargetId("letterA");

        manager.RequestLocalClaimMailAttachment("req_mail_stale", MailboxTileX, MailboxTileY, targetId, harness.DeadlineMs);

        // Somebody else claimed "letterA" while the actor was walking.
        harness.QueueLetters("letterB");
        harness.StandAt(MailboxTileX - 1, MailboxTileY);

        LocalExecutionReceipt arrival = harness.RunArrival(manager, "req_mail_stale");

        arrival.State.Should().Be(ExecutionState.Rejected);
        arrival.ReasonCode.Should().Be(
            "mail_target_changed",
            "the published identity binds the pending count and the head letter, so a served target is refused rather than re-targeted");
        arrival.Evidence.Should().Contain("pending=1");
        Game1.mailbox.Should().Equal(new[] { "letterB" }, "nothing was claimed: the walk refused before the native call");
        Game1.activeClickableMenu.Should().BeNull("no letter was opened");
        harness.Actor.mailReceived.Should().BeEmpty("no letter was recorded");
    }

    // ---------------------------------------------------------------------------------

    /// <summary>
    /// A headless farm with the two map layers the engine reads, the game statics the mailbox
    /// lookup dereferences, and a probe farmer whose tile the cases move. The whole assembly runs
    /// without parallelization, so restoring the statics on dispose is sufficient.
    /// </summary>
    private sealed class MailboxHarness : IDisposable
    {
        private const long ActorId = 1001;

        private readonly Game1? gameBefore;
        private readonly Farmer? playerBefore;
        private readonly object? worldStateBefore;
        private readonly object? otherFarmersBefore;
        private readonly object? locationLookupBefore;

        private MailboxHarness()
        {
            this.gameBefore = Game1.game1;
            this.playerBefore = Game1.player;
            this.worldStateBefore = Field(typeof(Game1), "netWorldState").GetValue(null);
            this.otherFarmersBefore = Field(typeof(Game1), "otherFarmers").GetValue(null);
            this.locationLookupBefore = Field(typeof(Game1), "_locationLookup").GetValue(null);
            this.Farm = null!;
            this.Actor = null!;
        }

        internal Farm Farm { get; private set; }

        internal Farmer Actor { get; private set; }

        internal long DeadlineMs { get; private set; }

        internal static MailboxHarness Create()
        {
            var harness = new MailboxHarness();

            // `NetPosition.Get` reads Game1.HostPaused and the mailbox lookup goes through
            // Game1.getFarm(), so the world state and the location book both have to exist.
            var root = (NetRoot<NetWorldState>)FormatterServices.GetUninitializedObject(typeof(NetRoot<NetWorldState>));
            root.Value = new NetWorldState();
            Field(typeof(Game1), "netWorldState").SetValue(null, root);
            Field(typeof(Game1), "otherFarmers").SetValue(null, new NetRootDictionary<long, Farmer>());
            Field(typeof(Game1), "_locationLookup").SetValue(null, new Dictionary<string, GameLocation>(StringComparer.OrdinalIgnoreCase));
            if (Game1.game1 is null)
                Game1.game1 = (Game1)FormatterServices.GetUninitializedObject(typeof(Game1));

            var farm = new Farm();
            var map = new xTile.Map();
            map.AddLayer(new xTile.Layers.Layer("Back", map, new xTile.Dimensions.Size(80, 40), new xTile.Dimensions.Size(64, 64)));
            map.AddLayer(new xTile.Layers.Layer("Buildings", map, new xTile.Dimensions.Size(80, 40), new xTile.Dimensions.Size(64, 64)));
            farm.map = map;
            InstanceField(farm, "name", new NetString("Farm"));
            InstanceField(Game1.game1, "_locations", new List<GameLocation> { farm });
            Game1.game1.instanceGameLocation = farm;

            var sprite = (FarmerSprite)FormatterServices.GetUninitializedObject(typeof(FarmerSprite));
            InstanceField(sprite, "spriteWidth", new NetInt(16));
            InstanceField(sprite, "spriteHeight", new NetInt(32));
            InstanceField(sprite, "tempSpriteHeight", -1);

            var actor = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
            InstanceField(actor, "uniqueMultiplayerID", new NetLong(ActorId));
            InstanceField(actor, "position", new NetPosition());
            InstanceField(actor, "currentLocationRef", new NetLocationRef());
            InstanceField(actor, "netMount", new NetRef<StardewValley.Characters.Horse>());
            InstanceField(actor, "sprite", new NetRef<AnimatedSprite> { Value = sprite });
            InstanceField(actor, "usingTool", new NetBool(false));
            InstanceField(actor, "netStamina", new NetFloat(270f));
            InstanceField(actor, "toolPower", new NetInt(0));
            InstanceField(actor, "mailbox", new NetStringList());
            InstanceField(actor, "mailReceived", new NetStringHashSet());
            InstanceField(actor, "netItems", new NetRef<StardewValley.Inventories.Inventory>(new StardewValley.Inventories.Inventory()));
            actor.CanMove = true;
            actor.freezePause = 0;
            actor.currentLocation = farm;
            Field(typeof(Game1), "_player").SetValue(null, actor);

            harness.Farm = farm;
            harness.Actor = actor;
            harness.DeadlineMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000;
            return harness;
        }

        /// <summary>Sets the actor's tile through the engine's own position, as a warp would.</summary>
        internal void StandAt(int tileX, int tileY) =>
            this.Actor.position.Set(new Microsoft.Xna.Framework.Vector2(tileX * 64 + 8, tileY * 64));

        /// <summary>Replaces the actor's pending queue with exactly these letters, in order.</summary>
        internal void QueueLetters(params string[] letters)
        {
            Game1.mailbox.Clear();
            foreach (string letter in letters)
                Game1.mailbox.Add(letter);
        }

        internal string PublishedTargetId(string headLetter) =>
            ExecutionManager.BuildMailboxTargetId(this.Farm, MailboxTileX, MailboxTileY, Game1.mailbox.Count, headLetter);

        internal ExecutionManager CreateManager()
        {
            var manager = new ExecutionManager(
                new DummyMonitor(),
                () => FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "claim_mail_attachment" }));
            manager.SetTestActorResolver(() => this.Actor);
            managers.Add(manager);
            return manager;
        }

        private readonly List<ExecutionManager> managers = new();

        /// <summary>The walk the request path armed, or null when it ran the claim in place.</summary>
        internal LocalApproachSpec? ArmedApproach()
        {
            ExecutionManager manager = this.managers.Last();
            return (LocalApproachSpec?)Field(
                typeof(ExecutionManager),
                "activeToolApproach",
                BindingFlags.NonPublic | BindingFlags.Instance).GetValue(manager);
        }

        /// <summary>
        /// The completion pass's own last step: the armed approach's arrival closure, run against
        /// the world as it stands now. The production caller reaches it from <c>Update</c> once the
        /// body is free; this calls the same delegate, so the case exercises the arrival path and
        /// not a second copy of it.
        /// </summary>
        internal LocalExecutionReceipt RunArrival(ExecutionManager manager, string requestId)
        {
            LocalApproachSpec approach = manager is null
                ? throw new ArgumentNullException(nameof(manager))
                : (LocalApproachSpec?)Field(
                    typeof(ExecutionManager),
                    "activeToolApproach",
                    BindingFlags.NonPublic | BindingFlags.Instance).GetValue(manager)
                    ?? throw new InvalidOperationException($"no approach is armed for {requestId}");
            return approach.Execute($"{approach.ExecutionId}_arrival", $"{approach.RequestId}_arrival");
        }

        private static FieldInfo Field(Type type, string name, BindingFlags flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static) =>
            type.GetField(name, flags) ?? throw new InvalidOperationException($"{type.Name}.{name} is missing");

        private static void InstanceField(object target, string name, object value) =>
            Field(target.GetType(), name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
                .SetValue(target, value);

        public void Dispose()
        {
            Field(typeof(Game1), "_player").SetValue(null, this.playerBefore);
            Field(typeof(Game1), "netWorldState").SetValue(null, this.worldStateBefore);
            Field(typeof(Game1), "otherFarmers").SetValue(null, this.otherFarmersBefore);
            Field(typeof(Game1), "_locationLookup").SetValue(null, this.locationLookupBefore);
            Game1.game1 = this.gameBefore!;
        }
    }
}



