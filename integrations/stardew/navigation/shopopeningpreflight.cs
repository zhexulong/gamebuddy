using System;
using System.Collections.Generic;
using System.Linq;
using StardewValley;

namespace GameBuddy.Stardew.Navigation;

/// <summary>
/// Narrow plan-time pre-flight for store-class destinations. It only rejects
/// what the native game guarantees cannot be reached: on festival days the
/// whole town's shops are closed (locked doors), so a store destination cannot
/// be entered. Opening hours themselves are a Game State Query property of
/// each shop's Data/Shops entry (e.g. !TIME 900 2100) rather than a fixed
/// Mod-side table; the Mod deliberately does not hard-code any shop schedule.
/// Store membership comes from the authoritative Data/Shops key set; any
/// destination whose location identity is not a shop key is not pre-flighted
/// (Backwoods, mines, outdoor areas pass through). Runtime door lock behavior
/// still guards execution even when this pre-flight passes.
/// </summary>
internal static class ShopOpeningPreflight
{
    /// <summary>
    /// Returns null when navigation may proceed, or a bounded evidence string
    /// (reason code: destination_closed_hours) when the destination is a shop
    /// that is festively closed today. Never throws; any data failure passes
    /// through so the native execution guard remains the authority.
    /// </summary>
    internal static string? Evaluate(
        string? canonicalDestinationIdentity,
        bool festivalToday,
        IReadOnlySet<string> shopKeys)
    {
        if (string.IsNullOrWhiteSpace(canonicalDestinationIdentity) || shopKeys is null)
            return null;
        string? locationName = ExtractLocationName(canonicalDestinationIdentity);
        if (locationName is null || !shopKeys.Contains(locationName, StringComparer.Ordinal))
            return null;
        if (!festivalToday)
            return null;
        return $"destination={locationName};festival=true";
    }

    /// <summary>location:SeedShop -> SeedShop; other shapes are not store locations.</summary>
    internal static string? ExtractLocationName(string canonicalDestinationIdentity)
    {
        const string Prefix = "location:";
        if (canonicalDestinationIdentity.StartsWith(Prefix, StringComparison.Ordinal))
        {
            string name = canonicalDestinationIdentity.Substring(Prefix.Length);
            return name.Length is >= 1 and <= 128 ? name : null;
        }
        return null;
    }

    /// <summary>
    /// Decode the lower/upper-case or prefixed canonical location identity into
    /// its store-key candidate. Keeps evaluation independent from how a binding
    /// was minted (label or ref).
    /// </summary>
    internal static string? TryGetShopKeyFromBinding(string? canonicalDestinationIdentity) =>
        ExtractLocationName(canonicalDestinationIdentity ?? string.Empty);

    /// <summary>
    /// Loads the authoritative shop key set from Data/Shops on the game thread.
    /// Returns an empty set when the asset is unreadable so pre-flight degrades
    /// to pass-through (native guards still apply).
    /// </summary>
    internal static IReadOnlySet<string> LoadShopKeys()
    {
        try
        {
            Dictionary<string, StardewValley.GameData.Shops.ShopData> shops =
                Game1.content.Load<Dictionary<string, StardewValley.GameData.Shops.ShopData>>("Data/Shops");
            return new HashSet<string>(shops.Keys.Where(key => key.Length is >= 1 and <= 128), StringComparer.Ordinal);
        }
        catch
        {
            return new HashSet<string>(StringComparer.Ordinal);
        }
    }
}