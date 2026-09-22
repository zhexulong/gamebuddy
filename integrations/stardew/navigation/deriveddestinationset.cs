using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using StardewValley;
using StardewValley.GameData.Characters;
using StardewValley.GameData.Locations;
using StardewValley.GameData.Objects;
using StardewValley.GameData.Shops;
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

            TryApplyNativeMetadata(destinations);

            // Water landmark (A.1): publish the farm water destination only
            // when at least one refillable water tile has a standable walk-in
            // neighbor (W rule: never bind the water tile itself; empty sets do
            // not publish). find_destination reaches the farm location; the exact
            // standable water-side tile is projected by observe_scene's
            // water_source affordance (A.2) — the chain stays orthogonal.
            if (locations.TryGetValue("Farm", out GameLocation[]? farmMatches) && farmMatches.Length == 1
                && TryCreateWaterLandmark(contentOwner, farmMatches[0], out NavigationDestination? water, out _)
                && water is not null)
            {
                destinations.Add(water);
                sourceNodes.Add(new NavigationSourceNode("water:farm", water.CanonicalLabel, water, null, Array.Empty<NavigationSourceNode>()));
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

    /// <summary>
    /// Attaches native 1.6 metadata to destinations so search recall is not
    /// limited to map labels: NPC residents (their canonical name and id) from
    /// Data/Characters join their home location, and each shop's key plus its
    /// stock item display names from Data/Shops join the home location of its
    /// owner NPC. All extracted lists are sorted and deduplicated. Any content
    /// failure degrades to the plain map-only destination list; this step is
    /// recall-optimizing only and never changes canonical identities, so
    /// Navigation bindings are unaffected.
    /// </summary>
    private static void TryApplyNativeMetadata(List<NavigationDestination> destinations)
    {
        try
        {
            IReadOnlyDictionary<string, CharacterData> characters = DataLoader.Characters(Game1.content);
            IReadOnlyDictionary<string, ShopData> shops = DataLoader.Shops(Game1.content);
            IReadOnlyDictionary<string, ObjectData> objects = DataLoader.Objects(Game1.content);

            Dictionary<string, int> indexByIdentity = new(StringComparer.Ordinal);
            for (int i = 0; i < destinations.Count; i++)
                indexByIdentity.TryAdd(destinations[i].CanonicalIdentity, i);

            Dictionary<string, string> npcHomes = new(StringComparer.Ordinal);
            Dictionary<string, List<string>> npcTerms = new(StringComparer.Ordinal);
            foreach (KeyValuePair<string, CharacterData> pair in characters.OrderBy(pair => pair.Key, StringComparer.Ordinal))
            {
                string npcId = pair.Key;
                string? home = GetDefaultHomeLocation(pair.Value);
                if (home is null || !indexByIdentity.ContainsKey(home))
                    continue;
                npcHomes[npcId] = home;
                if (!npcTerms.TryGetValue(home, out List<string>? terms))
                    npcTerms[home] = terms = new List<string>();
                terms.Add(npcId);
                string? displayName = ParseSearchableText(pair.Value.DisplayName);
                if (displayName is not null && !StringComparer.Ordinal.Equals(displayName, npcId))
                    terms.Add(displayName);
            }

            Dictionary<string, List<string>> serviceTerms = new(StringComparer.Ordinal);
            foreach (KeyValuePair<string, ShopData> pair in shops.OrderBy(pair => pair.Key, StringComparer.Ordinal))
            {
                string shopKey = pair.Key;
                List<string> ownerHomes = new();
                foreach (ShopOwnerData owner in pair.Value.Owners ?? Enumerable.Empty<ShopOwnerData>())
                {
                    if (owner is null || string.IsNullOrWhiteSpace(owner.Name)
                        || !npcHomes.TryGetValue(owner.Name, out string? home) || !indexByIdentity.ContainsKey(home))
                        continue;
                    if (!ownerHomes.Contains(home, StringComparer.Ordinal))
                        ownerHomes.Add(home);
                }
                if (ownerHomes.Count == 0)
                    continue;
                List<string> terms = new() { shopKey };
                foreach (ShopItemData item in (pair.Value.Items ?? Enumerable.Empty<ShopItemData>()).OrderBy(item => item.Id, StringComparer.Ordinal))
                {
                    string? itemName = GetItemDisplayName(item, objects);
                    if (itemName is not null)
                        terms.Add(itemName);
                }
                string[] orderedTerms = terms.Where(term => !string.IsNullOrWhiteSpace(term))
                    .Distinct(StringComparer.Ordinal)
                    .OrderBy(term => term, StringComparer.Ordinal)
                    .ToArray();
                foreach (string home in ownerHomes)
                {
                    if (!serviceTerms.TryGetValue(home, out List<string>? list))
                        serviceTerms[home] = list = new List<string>();
                    list.AddRange(orderedTerms);
                }
            }

            for (int i = 0; i < destinations.Count; i++)
            {
                NavigationDestination destination = destinations[i];
                IReadOnlyList<string>? npcs = SortTerms(npcTerms, destination.CanonicalIdentity);
                IReadOnlyList<string>? services = SortTerms(serviceTerms, destination.CanonicalIdentity);
                if (npcs is null && services is null)
                    continue;
                destinations[i] = destination with { RelatedNpcs = npcs, ServiceTerms = services };
            }
        }
        catch
        {
            // Enrichment is recall-optimizing only; keep the plain map-only list.
        }
    }

    /// <summary>
    /// Deterministically selects the NPC's default home: the first
    /// unconditional home entry, otherwise the first entry in stable content
    /// order.
    /// </summary>
    private static string? GetDefaultHomeLocation(CharacterData character)
    {
        if (character.Home is null)
            return null;
        foreach (CharacterHomeData home in character.Home
            .Where(home => !string.IsNullOrWhiteSpace(home.Location))
            .OrderBy(home => string.IsNullOrEmpty(home.Condition) ? 0 : 1)
            .ThenBy(home => home.Location, StringComparer.Ordinal)
            .ThenBy(home => home.Id, StringComparer.Ordinal))
        {
            return home.Location;
        }
        return null;
    }

    private static string? GetItemDisplayName(ShopItemData item, IReadOnlyDictionary<string, ObjectData> objects)
    {
        string? direct = ParseSearchableText(item.ObjectDisplayName);
        if (direct is not null)
            return direct;
        string itemId = item.ItemId ?? string.Empty;
        int closingBracket = itemId.IndexOf(')');
        if (closingBracket < 0 || closingBracket + 1 >= itemId.Length)
            return null;
        string key = itemId.Substring(closingBracket + 1);
        return objects.TryGetValue(key, out ObjectData? objectData)
            ? ParseSearchableText(objectData.DisplayName)
            : null;
    }

    private static string? ParseSearchableText(string? text)
    {
        if (string.IsNullOrWhiteSpace(text))
            return null;
        string parsed = TokenParser.ParseText(text, null, null, null) ?? text;
        return parsed.Length is >= 1 and <= 128 ? parsed : null;
    }

    private static IReadOnlyList<string>? SortTerms(Dictionary<string, List<string>> termsByIdentity, string identity)
    {
        if (!termsByIdentity.TryGetValue(identity, out List<string>? terms) || terms.Count == 0)
            return null;
        string[] ordered = terms.Distinct(StringComparer.Ordinal).OrderBy(term => term, StringComparer.Ordinal).ToArray();
        return ordered.Length == 0 ? null : ordered;
    }

    private static bool TryCreateWaterLandmark(
        string contentOwner,
        GameLocation farm,
        out NavigationDestination? destination,
        out string reasonCode)
    {
        destination = null;
        reasonCode = "farm_water_unavailable";
        // Surrounding Standable Set: a water tile itself is impassable; the
        // landmark is only valid while at least one eligible water tile has a
        // passable neighbor the Farmhand can stand on. The set is derived from
        // CanRefillWateringCanOnTile + isTilePassable so discovery and arrival
        // can never target the water tile. Scan only the loaded map bounds.
        if (farm.map is null || farm.map.Layers.Count == 0)
            return false;
        int width = farm.map.Layers[0].LayerWidth;
        int height = farm.map.Layers[0].LayerHeight;
        bool hasStandableWaterEdge = false;
        for (int x = 0; x < width && !hasStandableWaterEdge; x++)
        {
            for (int y = 0; y < height && !hasStandableWaterEdge; y++)
            {
                if (!farm.CanRefillWateringCanOnTile(x, y))
                    continue;
                foreach ((int nx, int ny) in new[] { (x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1) })
                {
                    if (nx >= 0 && ny >= 0 && nx < width && ny < height
                        && farm.isTilePassable(new xTile.Dimensions.Location(nx, ny), Game1.viewport))
                    {
                        hasStandableWaterEdge = true;
                        break;
                    }
                }
            }
        }
        if (!hasStandableWaterEdge)
            return false;
        // The canonical identity stays the farm location identity so the
        // existing route-planner arrival semantics (sources == destination)
        // keep working; the water marker is the label, not a new authority.
        destination = new NavigationDestination(
            contentOwner,
            "Farm",
            "Pond",
            null,
            null,
            new[] { "Pond", "Well", "池塘", "水井", "水源" });
        reasonCode = "accepted";
        return true;
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
    IReadOnlyList<string>? ExplicitAliases = null,
    IReadOnlyList<string>? RelatedNpcs = null,
    IReadOnlyList<string>? ServiceTerms = null
);
