using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using FluentAssertions;
using Microsoft.Xna.Framework;
using Netcode;
using StardewValley;
using StardewValley.Network;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// WHAT MAKES A COUNTER PURCHASABLE, asked of the gate the engine actually has.
///
/// <para>
/// Measured round42 (live), six refusals and one wasted day:
/// </para>
/// <code>
/// shop_purchase rejected  shop_counter_out_of_reach
///   owner=Pierre;owner_tile=4,17;actor_tile=5,19;radius=1
/// </code>
/// <para>
/// The world let her stand at (5,19); the counter is the row in front of Pierre and the game would have opened it
/// from there and sold her the seed. The refusal was measured against the OWNER NPC, and no native shop path measures
/// that distance: <c>Utility.TryOpenShopMenu(shopId, location, ...)</c> resolves the eligible owner entries and searches
/// the room's characters (<c>Utility.cs:4243-4268</c>), and the radius the engine does apply -
/// <c>Utility.tileWithinRadiusOfPlayer(tile, 1, player)</c> - is applied to the TILE before
/// <c>GameLocation.checkAction</c> (<c>Game1.cs:11509</c>, <c>:11637</c>). The two facts are therefore stated separately
/// below: an NPC-run counter has no distance at all, and a tile counter has exactly the engine's radius on its own tile.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the pins here assert on repository source text where the native seam cannot load headless, while the rest of the class drives the product's own predicates with a real Farmer; keeping both in one file keeps each pin beside the behaviour it protects.
public sealed class ShopCounterReachTests
{
    private const string ImplementationRelativePath = "integrations/stardew/farmhandexecutioncontroller.shopactions.cs";

    /// <summary>The round42 pair: the owner's tile and the tile the actor was standing on.</summary>
    private const int OwnerX = 4;
    private const int OwnerY = 17;
    private const int ActorX = 5;
    private const int ActorY = 19;

    /// <summary>
    /// THE MEASURED CASE. An NPC-run counter is admitted from wherever the actor stands in the room, including from two
    /// tiles away from Pierre - the distance that produced all six refusals - because the engine's own open call, not a
    /// radius, is what decides it.
    /// </summary>
    [Fact]
    public void AnNpcRunCounterIsAdmittedFromWhereverTheActorStandsInTheRoom()
    {
        using ActorHarness harness = ActorHarness.Create();

        harness.StandOn(ActorX, ActorY);
        ExecutionManager
            .ShopCounterReachRefusal(counterIsTileAction: false, "Pierre", OwnerX, OwnerY, harness.Actor)
            .Should()
            .BeNull("round42: the shop was at (4,17), she stood at (5,19), and no native shop path measures that");

        harness.StandOn(ActorX + 4, ActorY + 4);
        ExecutionManager
            .ShopCounterReachRefusal(counterIsTileAction: false, "Pierre", OwnerX, OwnerY, harness.Actor)
            .Should()
            .BeNull("the engine searches the room's whole character list (Utility.cs:4243-4268), so distance cannot refuse");

        harness.StandOn(OwnerX, OwnerY);
        ExecutionManager
            .ShopCounterReachRefusal(counterIsTileAction: false, "Pierre", OwnerX, OwnerY, harness.Actor)
            .Should()
            .BeNull("standing on the counter tile is not a worse place to buy from either");
    }

    /// <summary>
    /// A TILE counter is the other form, and there the engine does gate on distance - on the tile it is about to action.
    /// The published refusal must BE that gate at every boundary: a hand-written Manhattan or Euclidean distance would
    /// disagree on the diagonal immediately, and then the row that says "in reach" is refused by the action that reads it.
    /// </summary>
    [Fact]
    public void ATileCounterIsAdmittedOnlyInsideTheEnginesRadiusOnThatTile()
    {
        using ActorHarness harness = ActorHarness.Create();

        (int X, int Y, bool InRange)[] cases =
        {
            (OwnerX, OwnerY, true),
            (OwnerX + 1, OwnerY, true),
            (OwnerX, OwnerY + 1, true),
            (OwnerX + 1, OwnerY + 1, true),
            (ActorX, ActorY, false),
            (OwnerX + 2, OwnerY, false),
            (OwnerX, OwnerY + 2, false),
            (OwnerX - 2, OwnerY + 2, false),
        };

        foreach ((int x, int y, bool inRange) in cases)
        {
            harness.StandOn(x, y);
            bool native = Utility.tileWithinRadiusOfPlayer(OwnerX, OwnerY, 1, harness.Actor);
            string? refusal = ExecutionManager.ShopCounterReachRefusal(
                counterIsTileAction: true, string.Empty, OwnerX, OwnerY, harness.Actor);

            native.Should().Be(inRange, $"the engine's gate is the rule being reported, at {x},{y}");
            (refusal is null).Should().Be(native, $"the counter's reach must BE the engine's answer at {x},{y}");
        }

        // The refusal names the TILE that has to be reached, the body, and the engine's own radius - the tokens a caller
        // computes an approach from, and the same three the round42 refusal carried.
        harness.StandOn(ActorX, ActorY);
        ExecutionManager
            .ShopCounterReachRefusal(counterIsTileAction: true, string.Empty, OwnerX, OwnerY, harness.Actor)
            .Should()
            .Be("owner=none;owner_tile=4,17;actor_tile=5,19;radius=1");
    }

    /// <summary>
    /// A counter that is shut today answers with DISCOVERY'S OWN WORD. The old purchase path answered
    /// <c>shop_counter_out_of_reach</c> with a <c>closed_message=</c> appended - a distance for a shop that was not open -
    /// so the companion walked closer, which could never have helped. One token, one meaning, both callers.
    /// </summary>
    [Fact]
    public void ACounterThatIsShutAnswersWithTheDiscoveryGatesOwnReason()
    {
        GameBuddy.Stardew.Core.Policy.DiscoveryExclusionReasons.ShopClosedToday.Should().Be("shop_closed_today");

        ExecutionManager
            .ShopClosedNowRefusal("SeedShop", "Pierre", OwnerX, OwnerY, ActorX, ActorY, "Pierre's shop is closed today.")
            .Should()
            .Be("shop=SeedShop;owner=Pierre;owner_tile=4,17;actor_tile=5,19;closed_message=Pierre's shop is closed today.");

        // A counter no NPC runs is spelled `none`, the same way every optional value is spelled in this action's evidence.
        ExecutionManager
            .ShopClosedNowRefusal("Joja", string.Empty, 2, 3, 2, 4, null)
            .Should()
            .Be("shop=Joja;owner=none;owner_tile=2,3;actor_tile=2,4");

        string source = File.ReadAllText(RepositorySourcePath(ImplementationRelativePath));
        int discoveryAt = source.IndexOf("exclusions.Record(\"shopTargets\", DiscoveryExclusionReasons.ShopClosedToday)", StringComparison.Ordinal);
        int purchaseAt = source.IndexOf("DiscoveryExclusionReasons.ShopClosedToday,", StringComparison.Ordinal);
        discoveryAt.Should().BeGreaterThanOrEqualTo(0, "discovery names the withheld counter in the family's exclusions");
        purchaseAt.Should().BeGreaterThan(discoveryAt, "the purchase path answers with the SAME token, not a second one");
        source.Should().NotContain(
            "\"shop_open_refused\"",
            "a shut counter is not an open-refusal: the reason is the one discovery already publishes");
    }

    /// <summary>
    /// The population gate: every reason a purchase can REFUSE with is named here with what it states, so a new refusal
    /// cannot appear without someone saying which world fact it reports. The four world answers are the counter being
    /// shut, the item not being sold, the item being out of stock and the purse being short; the rest are identity or
    /// request-shape answers, which are not about the trade.
    /// </summary>
    [Fact]
    public void EveryRefusalAPurchaseCanReachIsNamedAndJustified()
    {
        IReadOnlyDictionary<string, string> declared = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            // The four the trade can answer with.
            ["shop_closed_today"] = "the counter is here and shut today: discovery's own reason, with the game's closed text",
            ["item_not_sold_here"] = "this counter does not offer that item at all",
            ["out_of_stock"] = "the counter offers it and has none left",
            ["insufficient_money"] = "the purse is short: price=/currency=/available=/held=/short=, the comparison and its gap",
            ["shop_counter_out_of_reach"] = "a TILE counter the actor cannot act on from here, or no eligible owner can run this counter from this room",
            // Identity and request shape: what the caller asked for, not what the world offered.
            ["shop_target_unavailable"] = "this id names no counter in this room",
            ["missing_expected_target_id"] = "the request named no counter",
            ["missing_expected_item"] = "the request named no item",
            ["invalid_quantity"] = "the request asked for fewer than one",
            ["world_not_ready"] = "the actor has no current location",
            ["modal_open"] = "a menu or dialogue is up, so this action would be driving over whatever opened it",
            ["shop_offer_not_purchasable"] = "the opened menu cannot reach the row, so no native click could buy it",
            // The Bookseller's own tile gate: refused rather than bypassed, because a real click would not have opened it.
            ["shop_tile_gate_refused"] = "the Bookseller stall is not open on this day of the season (GameLocation.cs:8727-8744)",
            ["shop_tile_requires_dialogue"] = "the Bookseller stall asks a Buy/Trade/Leave question, which this action does not drive",
        };

        string body = MethodBody(
            File.ReadAllText(RepositorySourcePath(ImplementationRelativePath)),
            "public LocalExecutionReceipt RequestLocalShopPurchase(");

        // Literal codes, plus the two the body spells as expressions: the bound-actor guard's own reason, and the closed
        // token shared with discovery (which is why `shop_closed_today` must NOT be a literal here).
        List<string> literal = Regex
            .Matches(body, "ExecutionState\\.Rejected,\\s*\"([a-z0-9_]+)\"")
            .Select(match => match.Groups[1].Value)
            .ToList();
        literal.Should().NotBeEmpty("the extraction must read the body's refusals, or this gate reads nothing");
        literal.Should().NotContain("shop_closed_today", "the closed token has ONE spelling, in DiscoveryExclusionReasons");

        HashSet<string> reached = new(literal, StringComparer.Ordinal);
        body.Should().Contain(
            "DiscoveryExclusionReasons.ShopClosedToday,",
            "the shut-counter refusal is emitted, through discovery's own token");
        reached.Add("shop_closed_today");

        reached.Should().BeEquivalentTo(declared.Keys, "every refusal must be declared with the fact it reports");
    }

    /// <summary>
    /// The other half of "stop lying": a refusal may not be decided by a distance to the OWNER, and a refusal that names a
    /// price may not skip the tokens the price comparison owes (<c>held=</c> and <c>short=</c>, asserted on the renderer by
    /// <see cref="ShopPurchasePriceComparisonTests"/>). Both are read from the body rather than from a second copy.
    /// </summary>
    [Fact]
    public void NoRefusalIsDecidedByADistanceToTheOwner()
    {
        string body = StripLineComments(MethodBody(
            File.ReadAllText(RepositorySourcePath(ImplementationRelativePath)),
            "public LocalExecutionReceipt RequestLocalShopPurchase("));

        body.Should().NotContain("OwnerInReach", "that fact is published for the caller to read, not enforced by the action");
        body.Should().NotContain("ShopOwnerInteractionRadius", "an NPC-proximity radius is not a gate the engine has");
        body.Should().NotContain(
            "tileWithinRadiusOfPlayer(",
            "the tile gate is asked through `ShopCounterReachRefusal`/`IsWithinRangeOfRequest`, which is the engine's own "
                + "call, so the action cannot measure a second distance beside it");
        body.Should().Contain("ShopCounterReachRefusal(", "the reach fact has one producer");

        // One RENDERER per token: two sites would be two meanings again. The code is reached from a tile outside the
        // engine's radius and from a counter no eligible owner can run in this room, and both spell the same three tokens.
        body.Should().Contain("\"shop_counter_out_of_reach\"", "the action refuses an unreachable counter");
        body.Should().NotContain(
            "radius=",
            "the radius token is produced by `ShopCounterReachEvidence` and respelled at no site");
        body.Should().Contain(
            "ShopCounterReachEvidence(",
            "the no-owner refusal renders its comparison through that one producer");
        Occurrences(body, "ShopPurchaseAffordabilityEvidence(").Should().Be(
            Occurrences(body, "price="),
            "every refusal whose evidence names a price renders it through the one producer that adds held=/short=");
    }

    private static int Occurrences(string source, string needle)
    {
        int count = 0;
        for (int index = source.IndexOf(needle, StringComparison.Ordinal); index >= 0;
             index = source.IndexOf(needle, index + needle.Length, StringComparison.Ordinal))
        {
            count++;
        }

        return count;
    }

    /// <summary>The brace-balanced body of the method whose signature starts at <paramref name="signature"/>.</summary>
    private static string MethodBody(string source, string signature)
    {
        int start = source.IndexOf(signature, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, $"{signature} must exist, or this gate reads nothing");
        int opening = source.IndexOf('{', start);
        int depth = 0;
        for (int cursor = opening; cursor < source.Length; cursor++)
        {
            if (source[cursor] == '{')
                depth++;
            else if (source[cursor] == '}' && --depth == 0)
                return source[opening..(cursor + 1)];
        }

        throw new InvalidOperationException("unbalanced method body");
    }

    /// <summary>Drops line comments, because the gate is about what the action DOES.</summary>
    private static string StripLineComments(string source)
    {
        string[] lines = source.Split('\n');
        for (int index = 0; index < lines.Length; index++)
        {
            int comment = lines[index].IndexOf("//", StringComparison.Ordinal);
            if (comment >= 0)
                lines[index] = lines[index][..comment];
        }

        return string.Join('\n', lines);
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
