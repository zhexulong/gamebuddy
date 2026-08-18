using StardewModdingAPI;
using StardewValley;
using StardewValley.Network;

namespace GameBuddy.Stardew;

/// <summary>Exact native-chat egress gate; no UI/input path or general reflection.</summary>
internal static class NativeChatPresentationPolicy
{
    /// <summary>Exact BCP-47 locale carried on the Host bridge, never an enum label.</summary>
    internal static bool IsCurrentLocale(string? locale) =>
        IsValidBcp47Locale(locale) && locale == CurrentBcp47Locale();

    internal static bool IsValidBcp47Locale(string? locale) =>
        locale is not null
        && System.Text.RegularExpressions.Regex.IsMatch(locale, "^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,16}){0,3}$");

    /// <summary>Farmhand Companion Preview supports only release-verified native locales.</summary>
    internal static bool IsRequiredLiveLocale(string? locale) => locale is "zh-CN" or "en-US";

    /// <summary>
    /// Fixture readiness checks the live game-thread locale only when the
    /// explicit Preview marker is present; ordinary fixture users stay outside
    /// this presentation-specific gate.
    /// </summary>
    internal static bool IsFixtureLiveLocaleAvailable(string? requiredLocale, string? currentLocale) =>
        string.IsNullOrEmpty(requiredLocale)
        || (IsRequiredLiveLocale(requiredLocale) && currentLocale == requiredLocale);

    internal static string CurrentBcp47Locale() =>
        CanonicalBcp47Locale(
            LocalizedContentManager.CurrentLanguageCode.ToString(),
            LocalizedContentManager.CurrentLanguageString);

    /// <summary>
    /// Converts Stardew's current locale surface to the Host's BCP-47 grammar.
    /// English is the sole built-in enum whose localized-asset suffix is empty.
    /// </summary>
    internal static string CanonicalBcp47Locale(string languageCode, string? languageString)
    {
        string locale = languageCode == "en" ? "en-US" : languageString ?? string.Empty;
        return IsValidBcp47Locale(locale) ? locale : string.Empty;
    }

    internal static bool IsExactMultiplayerField(System.Reflection.FieldInfo? field) =>
        field is not null
        && field.DeclaringType == typeof(Game1)
        && field.Name == "multiplayer"
        && field.FieldType == typeof(Multiplayer)
        && field.IsStatic;

    internal static bool IsBoundHumanRecipient(Farmer? configuredFarmhand)
    {
        Farmer? localPlayer = Game1.player;
        Farmer? hostPlayer = Game1.MasterPlayer;
        return Context.IsWorldReady
            && configuredFarmhand is not null
            && localPlayer is not null
            && hostPlayer is not null
            && localPlayer.UniqueMultiplayerID == configuredFarmhand.UniqueMultiplayerID
            && hostPlayer.UniqueMultiplayerID != configuredFarmhand.UniqueMultiplayerID;
    }
}
