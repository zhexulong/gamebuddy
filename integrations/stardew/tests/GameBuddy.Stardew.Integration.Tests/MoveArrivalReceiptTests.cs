using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using FluentAssertions;
using Microsoft.Xna.Framework;
using Netcode;
using StardewValley;
using StardewValley.Network;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// What a <c>target_reached</c> receipt says about the tile the caller ASKED for.
///
/// <para>
/// Measured 2026-11-09 (round41), four separate moves in one run - one of them the run's first receipt:
/// </para>
/// <code>
/// move_to_tile succeeded  {"already_at_target=true;tile=4,19;target=4,19;requested=4,18;adjacent_arrival=true"}
/// shop_purchase rejected  {"owner=Pierre;owner_tile=4,17;actor_tile=4,19;radius=1"}
/// </code>
/// <para>
/// The approach substitution had replaced the requested tile (4,18) with a standable neighbour (4,19) - correct in
/// itself, because a tile that holds the thing the caller wants to touch cannot be stood on - and then reported
/// <c>already_at_target=true</c> for the SUBSTITUTE while printing <c>requested=</c>. A reader that computes reach from
/// the request therefore believed the body stood on 4,18, one tile from the counter; it stood on 4,19, two. The two
/// facts below separate what was conflated: <c>reached</c> says whether the body is on the requested tile, and
/// <c>within_range_of_request</c> says whether it can still ACT on that tile, asked of the engine's own gate rather
/// than of a second distance written here.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the pins here assert on repository source text because the native seam they cover cannot load in a headless runner, while the rest of the class constructs and calls product code for real; keeping both in one file keeps each pin beside the behaviour it protects.
public sealed class MoveArrivalReceiptTests
{
    private const int RequestedX = 4;
    private const int RequestedY = 18;

    private const string MovementActions = "integrations/stardew/farmhandexecutioncontroller.movementactions.cs";

    [Fact]
    public void ABodyOnTheRequestedTileSaysItReachedTheRequest()
    {
        ExecutionManager
            .DescribeMoveArrival((RequestedX, RequestedY), (RequestedX, RequestedY), withinRangeOfRequest: true)
            .Should().Be(
                "reached=requested;requested=4,18;actor=4,18;within_range_of_request=true",
                "the only case that may say `reached=requested` is the body actually standing on the requested tile");
    }

    [Fact]
    public void ABodyOnASubstitutedNeighbourNeverClaimsItArrived()
    {
        // The exact run41 shape: request (4,18), body (4,19).
        string evidence = ExecutionManager.DescribeMoveArrival((RequestedX, RequestedY), (4, 19), withinRangeOfRequest: true);

        evidence.Should().Be("reached=adjacent;requested=4,18;actor=4,19;within_range_of_request=true");
        evidence.Should().NotContain("already_at_target", "the substituted tile is not the requested tile");
        evidence.Should().NotContain("reached=requested");
    }

    [Fact]
    public void ASubstitutionThatCannotActOnTheRequestSaysSo()
    {
        // The refusal branch's wording: the two tiles and the measured verdict, so a caller can re-aim instead of
        // reading a success and having the NEXT action refuse.
        ExecutionManager
            .DescribeMoveArrival((RequestedX, RequestedY), (4, 25), withinRangeOfRequest: false)
            .Should().Be("reached=adjacent;requested=4,18;actor=4,25;within_range_of_request=false");
    }

    [Fact]
    public void TheRangeFactIsTheNativeInteractionRadiusAndNotASecondDistance()
    {
        // `shop_purchase` refuses with `shop_counter_out_of_reach` at `Utility.tileWithinRadiusOfPlayer(owner_tile, 1,
        // player)` and `Game1.checkAction` gates the click path on the same radius. This asserts the published fact
        // agrees with that function at every boundary - a hand-written Manhattan or Euclidean distance would disagree
        // on the diagonal immediately.
        using ActorHarness harness = ActorHarness.Create();

        (int X, int Y, bool InRange)[] cases =
        {
            (RequestedX, RequestedY, true),
            (RequestedX - 1, RequestedY, true),
            (RequestedX, RequestedY + 1, true),
            (RequestedX - 1, RequestedY + 1, true),
            (RequestedX - 2, RequestedY, false),
            (RequestedX, RequestedY + 2, false),
            (RequestedX - 2, RequestedY + 2, false),
        };

        foreach ((int x, int y, bool expected) in cases)
        {
            harness.StandOn(x, y);
            bool native = Utility.tileWithinRadiusOfPlayer(RequestedX, RequestedY, 1, harness.Actor);
            bool published = ExecutionManager.IsWithinRangeOfRequest((RequestedX, RequestedY), harness.Actor);

            native.Should().Be(expected, $"the engine's gate is the rule being published, at {x},{y}");
            published.Should().Be(native, $"within_range_of_request must BE the engine's answer at {x},{y}");
        }

        // The run41 pair, stated: the substitute (4,19) IS within the request's ring, so the range fact is true.
        // What was false there was the ARRIVAL claim - which is why the two facts are published separately.
        harness.StandOn(4, 19);
        ExecutionManager.IsWithinRangeOfRequest((RequestedX, RequestedY), harness.Actor)
            .Should().BeTrue("a ring neighbour can still act on the requested tile; the lie was `already_at_target`");
    }

    [Fact]
    public void TheMoveBodyBuildsTheReceiptFromThoseFactsAndRefusesAnApproachOutOfReach()
    {
        string source = File.ReadAllText(RepositorySourcePath(MovementActions));
        int start = source.IndexOf("public LocalExecutionReceipt RequestLocalMove(", StringComparison.Ordinal);
        int end = source.IndexOf("internal static Vector2? SelectStandingApproachTile(", start, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0);
        end.Should().BeGreaterThan(start);
        string body = source[start..end];

        body.Should().NotContain(
            "already_at_target",
            "no receipt may claim the body is at a tile it was substituted away from");
        body.Should().Contain(
            "DescribeMoveArrival(",
            "the arrival receipt has one producer, so the shapes above are the only shapes it can take");
        body.Should().Contain(
            "IsWithinRangeOfRequest(",
            "the range fact is asked of the engine gate, not computed at the call site");
        body.Should().Contain(
            "ApproachOutOfReachReasonCode",
            "a substitution that cannot reach the request must refuse instead of reporting success");
    }

    private static string RepositorySourcePath(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (File.Exists(candidate))
                    return candidate;
                directory = directory.Parent;
            }
        }

        throw new FileNotFoundException($"repository source not found: {relative}");
    }

    /// <summary>
    /// A real <see cref="Farmer"/> with the engine's 48x32 body, placed on whole tiles, plus the <c>Game1</c> statics
    /// <see cref="Character.Tile"/> dereferences (<c>NetPosition.Get</c> reads <c>Game1.HostPaused</c>,
    /// <c>StandingPixel</c> reads the sprite and the mount). The assembly already runs without parallelization, so
    /// restoring the statics on dispose is sufficient.
    /// </summary>
    private sealed class ActorHarness : IDisposable
    {
        private readonly Game1? gameBefore;
        private readonly Farmer? playerBefore;
        private readonly object? worldStateBefore;

        private ActorHarness()
        {
            this.gameBefore = Game1.game1;
            this.playerBefore = Game1.player;
            this.worldStateBefore = typeof(Game1)
                .GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!
                .GetValue(null);
            this.Actor = null!;
        }

        public Farmer Actor { get; private set; }

        public static ActorHarness Create()
        {
            var harness = new ActorHarness();

            var root = (NetRoot<NetWorldState>)System.Runtime.Serialization.FormatterServices
                .GetUninitializedObject(typeof(NetRoot<NetWorldState>));
            root.Value = new NetWorldState();
            typeof(Game1)
                .GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!
                .SetValue(null, root);
            if (Game1.game1 is null)
                Game1.game1 = (Game1)System.Runtime.Serialization.FormatterServices.GetUninitializedObject(typeof(Game1));

            var sprite = (FarmerSprite)System.Runtime.Serialization.FormatterServices
                .GetUninitializedObject(typeof(FarmerSprite));
            SetField(sprite, "spriteWidth", new NetInt(16));
            SetField(sprite, "spriteHeight", new NetInt(32));
            SetField(sprite, "tempSpriteHeight", -1);

            var actor = (Farmer)System.Runtime.Serialization.FormatterServices.GetUninitializedObject(typeof(Farmer));
            SetField(actor, "position", new NetPosition());
            SetField(actor, "currentLocationRef", new NetLocationRef());
            SetField(actor, "netMount", new NetRef<StardewValley.Characters.Horse>());
            SetField(actor, "sprite", new NetRef<AnimatedSprite> { Value = sprite });
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, actor);

            harness.Actor = actor;
            harness.StandOn(0, 0);
            return harness;
        }

        /// <summary>Puts the body on <paramref name="x"/>,<paramref name="y"/>: tile centre in X, tile top in Y.</summary>
        public void StandOn(int x, int y) => this.Actor.position.Set(new Vector2(x * 64 + 8, y * 64));

        private static void SetField(object target, string name, object value) =>
            target.GetType()
                .GetField(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(target, value);

        public void Dispose()
        {
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, this.playerBefore);
            typeof(Game1)
                .GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!
                .SetValue(null, this.worldStateBefore);
            Game1.game1 = this.gameBefore!;
        }
    }
}
