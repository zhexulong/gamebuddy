using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using StardewValley;
using StardewValley.GameData.Locations;
using StardewValley.TokenizableStrings;
using StardewValley.WorldMaps;

namespace GameBuddy.Stardew.Navigation;

/// <summary>
/// One immutable Mod-owned current-world destination snapshot. Source nodes are
/// private provenance; the public projection exposes only legal labels and
/// opaque selectors.
/// </summary>
internal sealed class DerivedDestinationSet
{
    internal DerivedDestinationSet(
        string generation,
        NavigationSourceNode root,
        IReadOnlyList<NavigationDestination>? searchDestinations = null)
    {
        if (string.IsNullOrWhiteSpace(generation))
            throw new ArgumentException("Generation is required.", nameof(generation));
        this.Generation = generation;
        this.Root = root ?? throw new ArgumentNullException(nameof(root));
        this.SearchDestinations = (searchDestinations ?? root.DescendantsAndSelf()
                .Where(node => node.Destination is not null)
                .Select(node => node.Destination!))
            .GroupBy(destination => destination.CanonicalIdentity, StringComparer.Ordinal)
            .Select(group => group.First())
            .OrderBy(destination => destination.CanonicalLabel, StringComparer.Ordinal)
            .ThenBy(destination => destination.CanonicalIdentity, StringComparer.Ordinal)
            .ToArray();
    }

    internal string Generation { get; }
    internal NavigationSourceNode Root { get; }
    internal IReadOnlyList<NavigationDestination> SearchDestinations { get; }

    internal static bool TryCreateCurrent(string contentOwner, out DerivedDestinationSet? set, out string reasonCode)
    {
        set = null;
        if (Game1.player is null || Game1.locations is null)
        {
            reasonCode = "world_map_unavailable";
            return false;
        }

        try
        {
            Dictionary<string, GameLocation[]> locations = Game1.locations
                .Where(location => !string.IsNullOrWhiteSpace(location.NameOrUniqueName))
                .GroupBy(location => location.NameOrUniqueName, StringComparer.Ordinal)
                .ToDictionary(group => group.Key, group => group.ToArray(), StringComparer.Ordinal);
            var regionIdentities = new List<(MapRegion Region, string Identity)>();
            foreach (MapRegion region in WorldMapManager.GetMapRegions())
            {
                HashSet<string> identities = new(StringComparer.Ordinal);
                foreach (MapArea area in region.GetAreas())
                foreach (MapAreaPosition position in area.GetWorldPositions())
                {
                    if (!string.IsNullOrWhiteSpace(position.Data.LocationName))
                        identities.Add(position.Data.LocationName);
                    foreach (string identity in position.Data.LocationNames ?? new List<string>())
                        if (!string.IsNullOrWhiteSpace(identity))
                            identities.Add(identity);
                }
                regionIdentities.AddRange(identities.Select(identity => (region, identity)));
            }

            Dictionary<string, List<GameLocation>> labels = new(StringComparer.Ordinal);
            foreach ((MapRegion region, string identity) in regionIdentities)
            {
                if (!locations.TryGetValue(identity, out GameLocation[]? matches) || matches.Length != 1)
                    continue;
                GameLocation location = matches[0];
                string label = TryGetLocationName(region, location);
                if (string.IsNullOrWhiteSpace(label) || label.Length > 128)
                    continue;
                if (!labels.TryGetValue(label, out List<GameLocation>? list))
                    labels[label] = list = new List<GameLocation>();
                if (!list.Any(candidate => candidate.NameOrUniqueName == location.NameOrUniqueName))
                    list.Add(location);
            }

            IReadOnlyDictionary<string, LocationData> currentData = DataLoader.Locations(Game1.content);
            IReadOnlyDictionary<string, LocationData>? fallbackData = TryLoadFallbackLocationData();
            Dictionary<string, string> contextualLabels = new(StringComparer.Ordinal);
            foreach ((string label, List<GameLocation> candidates) in labels)
            foreach (GameLocation location in candidates)
            {
                if (!contextualLabels.TryAdd(location.NameOrUniqueName, label)
                    && !StringComparer.Ordinal.Equals(contextualLabels[location.NameOrUniqueName], label))
                    contextualLabels.Remove(location.NameOrUniqueName);
            }

            List<NavigationSourceNode> sourceNodes = new();
            foreach ((string label, List<GameLocation> candidates) in labels.OrderBy(pair => pair.Key, StringComparer.Ordinal))
            foreach (GameLocation location in candidates.OrderBy(candidate => candidate.NameOrUniqueName, StringComparer.Ordinal))
            {
                string identity = location.NameOrUniqueName;
                string? fallbackLabel = TryGetDisplayLabel(fallbackData, identity);
                IReadOnlyList<string>? aliases = BuildExplicitAliases(label, TryGetDisplayLabel(currentData, identity), fallbackLabel);
                sourceNodes.Add(new NavigationSourceNode(
                    $"location:{identity}", label,
                    new NavigationDestination(contentOwner, identity, label, null, fallbackLabel, aliases),
                    null, Array.Empty<NavigationSourceNode>()));
            }

            List<NavigationDestination> destinations = new();
            foreach ((string identity, GameLocation[] matches) in locations.OrderBy(pair => pair.Key, StringComparer.Ordinal))
            {
                if (matches.Length != 1)
                    continue;
                string? label = TryGetDisplayLabel(currentData, identity);
                if (string.IsNullOrWhiteSpace(label))
                    continue;
                string? fallbackLabel = TryGetDisplayLabel(fallbackData, identity);
                contextualLabels.TryGetValue(identity, out string? contextLabel);
                IReadOnlyList<string>? aliases = BuildExplicitAliases(label, contextLabel, fallbackLabel);
                destinations.Add(new NavigationDestination(contentOwner, identity, label, null, fallbackLabel, aliases));
            }

            string generation = ComputeGeneration(destinations);
            set = new DerivedDestinationSet(generation, new NavigationSourceNode("root", null, null, null, sourceNodes), destinations);
            reasonCode = "accepted";
            return true;
        }
        catch
        {
            reasonCode = "world_map_unavailable";
            return false;
        }
    }

    private static IReadOnlyDictionary<string, LocationData>? TryLoadFallbackLocationData()
    {
        var currentLanguage = LocalizedContentManager.CurrentLanguageCode;
        var fallbackLanguage = (int)currentLanguage == 0 ? 5 : 0;
        try
        {
            IReadOnlyDictionary<string, LocationData> data = Game1.content.Load<Dictionary<string, LocationData>>("Data/Locations", (StardewValley.LocalizedContentManager.LanguageCode)fallbackLanguage);
            return LocalizedContentManager.CurrentLanguageCode == currentLanguage ? data : null;
        }
        catch
        {
            return null;
        }
    }

    private static string? TryGetDisplayLabel(IReadOnlyDictionary<string, LocationData>? locationData, string identity)
    {
        if (locationData is null || !locationData.TryGetValue(identity, out LocationData? value)
            || string.IsNullOrWhiteSpace(value.DisplayName))
            return null;
        string text = TokenParser.ParseText(value.DisplayName, null, null, null) ?? string.Empty;
        return text.Length is >= 1 and <= 128 ? text : null;
    }

    private static IReadOnlyList<string>? BuildExplicitAliases(string canonicalLabel, string? currentLabel, string? fallbackLabel)
    {
        string[] aliases = new[] { currentLabel, fallbackLabel }
            .OfType<string>()
            .Where(label => !StringComparer.Ordinal.Equals(label, canonicalLabel))
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        return aliases.Length == 0 ? null : aliases;
    }

    private static string TryGetLocationName(MapRegion region, GameLocation location) =>
        typeof(MapRegion).GetMethod("GetLocationName", BindingFlags.Instance | BindingFlags.NonPublic,
            null, new[] { typeof(GameLocation) }, null)?.Invoke(region, new object[] { location }) as string ?? string.Empty;

    private static string ComputeGeneration(IEnumerable<NavigationDestination> destinations)
    {
        string serialized = string.Join("\n", destinations.Select(destination => destination.CanonicalIdentity)
            .OrderBy(identity => identity, StringComparer.Ordinal)) + "\n";
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(serialized))).ToLowerInvariant();
    }
}

/// <summary>
/// A filtered source-derived node. <see cref="InternalId"/> is private and
/// never projected. A null label makes the node structural-only.
/// </summary>
internal sealed record NavigationSourceNode(
    string InternalId,
    string? Label,
    NavigationDestination? Destination,
    string? ContextLabel,
    IReadOnlyList<NavigationSourceNode> Children
)
{
    internal IEnumerable<NavigationSourceNode> DescendantsAndSelf()
    {
        yield return this;
        foreach (NavigationSourceNode child in Children)
        foreach (NavigationSourceNode descendant in child.DescendantsAndSelf())
            yield return descendant;
    }
}

/// <summary>Private canonical identity, not a public selector.</summary>
internal sealed record NavigationDestination(
    string ContentOwner,
    string CanonicalIdentity,
    string CanonicalLabel,
    string? ContextLabel,
    string? FallbackLabel = null,
    IReadOnlyList<string>? ExplicitAliases = null
);
