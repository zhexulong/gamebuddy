using StardewModdingAPI;

namespace GameBuddy.Stardew;

/// <summary>
/// The player's way into her conversation, as policy a runner can decide without a game: which key opens the engine's
/// chat box, the words the player is shown, and the one gate that decides whether the box may be opened at all.
///
/// <para>
/// WHY THE ENGINE'S CHAT BOX AND NOT A TEXT FIELD OF OUR OWN. It is the engine's own text entry: its 9-slice box, its
/// caret, its paste and history, and - the part that matters - its own submit seam
/// <c>ChatBox.textBoxEnter(string)</c>, which this Mod already observes and forwards to the Host as
/// <c>player_input</c>. A second <c>TextBox</c> would have to be drawn, positioned and submitted by us, and the lesson
/// from the speech bubble was that a panel we cut out is worse than the one the game draws.
/// </para>
/// <para>
/// MEASURED, NOT ASSUMED (live 1.6.15 single-player fixture session, companion-chat probe): <c>activate()</c> leaves
/// <c>isActive()</c> true with the <c>ChatTextBox</c> installed as <c>Game1.keyboardDispatcher.Subscriber</c>, and text
/// driven through that subscriber reaches <c>ChatBox.textBoxEnter(string)</c> with exactly what was typed.
/// </para>
/// </summary>
internal static class CompanionChat
{
    internal const string AcceptedReason = "accepted";
    internal const string InvalidKeyReason = "companion_chat_key_invalid";
    internal const string ReservedKeyReason = "companion_chat_key_reserved";

    /// <summary>
    /// The vanilla key that already opens this exact box (<c>Game1.UpdateChatBox</c> compares
    /// <c>Game1.options.chatButton</c>, whose default is T and '/'). Binding it here would give one keystroke two owners.
    /// </summary>
    internal const SButton VanillaChatKey = SButton.T;

    /// <summary>Long enough to read two clauses, short enough that it leaves on its own.</summary>
    internal const float HintDurationMs = 10_000f;

    /// <summary>
    /// The profile's key, parsed the way the player typed it. A value that is not a key is refused by name rather than
    /// silently becoming <see cref="SButton.None"/> - an unparsed key would leave the feature unreachable with no line
    /// anywhere saying why.
    /// </summary>
    internal static bool TryParseOpenKey(string? configured, out SButton button, out string reasonCode)
    {
        button = SButton.None;
        string value = configured?.Trim() ?? string.Empty;
        if (value.Length == 0 || !Enum.TryParse(value, ignoreCase: true, out button) || button == SButton.None)
        {
            button = SButton.None;
            reasonCode = InvalidKeyReason;
            return false;
        }
        if (button == VanillaChatKey)
        {
            button = SButton.None;
            reasonCode = ReservedKeyReason;
            return false;
        }
        reasonCode = AcceptedReason;
        return true;
    }

    /// <summary>The title above the box: the only place the player is told who they are typing to.</summary>
    internal static string TitleText(string companionName, string? locale) =>
        IsChinese(locale)
            ? $"和{Name(companionName)}说话"
            : $"Talk to {Name(companionName)}";

    /// <summary>The one-time arrival hint: the key, and the fact that she is standing in this world.</summary>
    internal static string HintText(string companionName, string keyLabel, string? locale) =>
        IsChinese(locale)
            ? $"按 {keyLabel} 和{Name(companionName)}说话 — 她就在这个世界里。"
            : $"Press {keyLabel} to talk to {Name(companionName)} — she is standing in this world.";

    /// <summary>
    /// Whether the box may be opened now. Every refusal is a state the player is already in: no world, a box that is
    /// already open, another text field that owns what they type (a naming menu, a sign), an open menu, a cutscene.
    /// </summary>
    internal static bool CanOpen(
        bool worldReady,
        bool alreadyActive,
        bool otherTextInputOwnsKeyboard,
        bool menuOpen,
        bool eventRunning) =>
        worldReady && !alreadyActive && !otherTextInputOwnsKeyboard && !menuOpen && !eventRunning;

    /// <summary>A profile with no name for her would otherwise produce a title addressed to nobody.</summary>
    internal static string Name(string? companionName) =>
        string.IsNullOrWhiteSpace(companionName) ? "GameBuddy" : companionName.Trim();

    private static bool IsChinese(string? locale) =>
        locale is not null && locale.StartsWith("zh", StringComparison.OrdinalIgnoreCase);
}
