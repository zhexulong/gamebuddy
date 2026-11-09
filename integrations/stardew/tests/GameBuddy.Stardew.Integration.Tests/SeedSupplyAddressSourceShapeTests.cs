using System;
using System.IO;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The `seedSupplyTargets` address half must be computed INSIDE the Mod, from the engine's own reads, and must name the
/// waypoint with the identity `shop_purchase` already resolves.
///
/// <para>
/// The rule (2026-11-09, after the round40 run): the Mod states world facts and the Host only reads and renders them.
/// So the shop's location and its reachable waypoint belong here, not in a Host-side join of `doorTargets` against a
/// shop row - a join in the reading layer decides what the world looks like, which is the failure this file pins
/// against. Two things must therefore be visible in the source and not merely claimed by it:
/// </para>
/// <list type="bullet">
///   <item>the location comes from <c>Game1.getLocationFromName</c> - the engine's own lookup, in which a shop id IS a
///       map name - and not from a table written here;</item>
///   <item>the waypoint's id and tile are READ from the published shop row, never re-minted: a second copy of the
///       identity agrees with the shop family today and disagrees with it after the next change.</item>
/// </list>
/// </summary>
[Trait("kind", "source-shape")]
public sealed class SeedSupplyAddressSourceShapeTests
{
    private const string ShopActionsFile = "farmhandexecutioncontroller.shopactions.cs";
    private const string ControllerFile = "farmhandexecutioncontroller.cs";

    /// <summary>
    /// Remove the engine read and this case fails BY NAME: the discovery would hand the address a null location, and the
    /// row would state `shop_location_unreadable` for every shop instead of the room it is in.
    /// </summary>
    [Fact]
    public void TheShopsLocationComesFromTheEnginesOwnLookup()
    {
        string code = StripLineComments(ReadSource(ShopActionsFile));

        string reader = MethodBody(code, "private static GameLocation? ShopOwningLocation(");
        reader.Should().Contain(
            "Game1.getLocationFromName(shopId)",
            "a shop id is a map name because the shop's counter lives in that map; the location must be the engine's "
            + "answer, not a constant");

        string discovery = MethodBody(code, "private IReadOnlyList<BridgeSeedSupplyTarget> DiscoverSeedSupplyTargets(");
        discovery.Should().Contain(
            "ShopOwningLocation(entry.ShopId)",
            "every stocked shop's own location is read and handed to its row");
        discovery.Should().Contain(
            "shopTargetsHere",
            "the waypoint is selected out of the shop-target list the snapshot published");
    }

    /// <summary>
    /// The address is SELECTED from the published row: its id, its tile, its location. `ShopTargetId` must not appear,
    /// because that is the minter, and a minter called twice is two authorities over one fact.
    /// </summary>
    [Fact]
    public void TheWaypointIsReadFromThePublishedShopRowAndNoIdIsMintedForIt()
    {
        string resolver = MethodBody(
            StripLineComments(ReadSource(ShopActionsFile)),
            "private static (BridgeSeedSupplyDestination? Destination, string? Location, string? Unknown) ResolveShopAddress(");

        resolver.Should().Contain("counter.TargetId", "the id is the published shop row's own id");
        resolver.Should().Contain("counter.Location");
        resolver.Should().Contain("counter.OwnerTileX");
        resolver.Should().Contain("counter.OwnerTileY");
        resolver.Should().NotContain(
            "ShopTargetId(",
            "minting an id here would agree with the shop family today and disagree with the purchase after the next "
            + "change to either");
        resolver.Should().Contain(
            "shop_location_unreadable",
            "the third state names WHY neither a waypoint nor a location could be published");
    }

    /// <summary>
    /// One shop-target list per snapshot feeds BOTH families. Two walks of `Data/Shops` could disagree about what this
    /// room sells, and the seed row would then name a counter `shop_purchase` refuses.
    /// </summary>
    [Fact]
    public void OneShopTargetListPerSnapshotFeedsBothFamilies()
    {
        string code = StripLineComments(ReadSource(ControllerFile));

        code.Should().Contain(
            "IReadOnlyList<BridgeShopTarget>? shopTargetsHere =",
            "the list is hoisted so the two families cannot read two different worlds");
        code.Should().Contain(
            "DiscoverSeedSupplyTargets(player, inventoryItemFacts, shopTargetsHere, out seedSupplyTargetsOmitted)",
            "the seed-supply discovery is handed the published list");
        code.Should().Contain(
            "advertisedCapabilities.Contains(\"shop_purchase\", StringComparer.Ordinal) ? shopTargetsHere : null",
            "`shopTargets` publishes that same list, never a second discovery");
        Occurrences(code, "DiscoverShopTargets(")
            .Should()
            .Be(1, "the shop family must be discovered exactly once per snapshot, or the two readers can disagree");
    }

    private static int Occurrences(string source, string needle)
    {
        int count = 0;
        for (int index = source.IndexOf(needle, StringComparison.Ordinal); index >= 0;
             index = source.IndexOf(needle, index + needle.Length, StringComparison.Ordinal))
            count++;
        return count;
    }

    /// <summary>Extract one member body by brace balance from its declaration.</summary>
    private static string MethodBody(string source, string declaration)
    {
        int start = source.IndexOf(declaration, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, $"{declaration} must exist");

        int depth = 0;
        bool started = false;
        for (int index = start; index < source.Length; index++)
        {
            char character = source[index];
            if (character == '{')
            {
                depth++;
                started = true;
            }
            else if (character == '}')
            {
                depth--;
                if (started && depth == 0)
                    return source[start..(index + 1)];
            }
        }

        throw new InvalidOperationException($"unbalanced body for {declaration}");
    }

    /// <summary>Drop <c>//</c>/<c>///</c> comments so the pins test code, not prose.</summary>
    private static string StripLineComments(string source)
    {
        var builder = new System.Text.StringBuilder(source.Length);
        foreach (string line in source.Split('\n'))
        {
            int comment = line.IndexOf("//", StringComparison.Ordinal);
            builder.AppendLine(comment >= 0 ? line[..comment] : line);
        }
        return builder.ToString();
    }

    private static string ReadSource(string fileName) =>
        ReadRepositoryFile(Path.Combine("integrations", "stardew", fileName));

    /// <summary>Tests run from the project or its bin output; walk up to the repository root.</summary>
    private static string ReadRepositoryFile(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (File.Exists(candidate))
                    return File.ReadAllText(candidate);
            }
        }

        throw new FileNotFoundException($"could not locate {relative} from {AppContext.BaseDirectory}");
    }
}
