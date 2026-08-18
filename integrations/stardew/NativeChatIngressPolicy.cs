namespace GameBuddy.Stardew;

/// <summary>
/// Version-locked policy for the one Harmony observation used by the native
/// Companion chat ingress. This class is deliberately pure so the target
/// boundary and text filter have direct deterministic coverage.
/// </summary>
internal enum NativeChatIngressTextClassification
{
    Ordinary,
    FilteredBlank,
    FilteredCommand,
    FilteredOversize,
}

internal static class NativeChatIngressPolicy
{
    // This native-chat observation is available only through the separately
    // authenticated native AI Farmhand topology. It deliberately inherits the
    // exact version triple already provisioned by that topology rather than
    // inventing a second target-version constant set.
    internal static bool IsSupportedRuntime(
        string gameVersion,
        int gameBuildNumber,
        string smapiVersion,
        string expectedGameVersion,
        int expectedGameBuildNumber,
        string expectedSmapiVersion) =>
        gameVersion == expectedGameVersion
        && gameBuildNumber == expectedGameBuildNumber
        && smapiVersion == expectedSmapiVersion;

    /// <summary>
    /// Only a non-command text value already submitted to the target game's
    /// ChatBox may be duplicated into the typed Companion input fact. This
    /// never reads ChatBox state or infers intent from natural language.
    /// </summary>
    internal static NativeChatIngressTextClassification ClassifySubmittedText(string? text)
    {
        if (string.IsNullOrWhiteSpace(text))
            return NativeChatIngressTextClassification.FilteredBlank;
        if (text.Length > PlayerControlProtocol.MaximumTextLength)
            return NativeChatIngressTextClassification.FilteredOversize;
        if (text.StartsWith("/", StringComparison.Ordinal))
            return NativeChatIngressTextClassification.FilteredCommand;
        return NativeChatIngressTextClassification.Ordinary;
    }

    internal static bool IsOrdinarySubmittedText(string? text) =>
        ClassifySubmittedText(text) == NativeChatIngressTextClassification.Ordinary;

    /// <summary>
    /// Guards the source-level text seam: exactly the target overload, its
    /// named text argument, and a postfix only. Harmony binds regular
    /// parameters by target name, so a type-only match would not prove the
    /// observation gets the submitted text.
    /// </summary>
    internal static bool IsTextSubmitPostfix(string? declaringType, string? methodName, Type[]? parameterTypes, string?[]? parameterNames, bool isPostfix) =>
        isPostfix
        && declaringType == "StardewValley.Menus.ChatBox"
        && methodName == "textBoxEnter"
        && parameterTypes is { Length: 1 }
        && parameterTypes[0] == typeof(string)
        && parameterNames is { Length: 1 }
        && parameterNames[0] == "text_to_send";

    /// <summary>
    /// The native Enter delegate targets the TextBox overload before it
    /// materializes submitted plaintext and calls the string overload. This
    /// companion prefix is diagnostic-only: it never reads its TextBox
    /// argument and therefore cannot become an alternate text ingress.
    /// </summary>
    internal static bool IsTextBoxDelegatePrefix(string? declaringType, string? methodName, Type[]? parameterTypes, string?[]? parameterNames, bool isPrefix) =>
        isPrefix
        && declaringType == "StardewValley.Menus.ChatBox"
        && methodName == "textBoxEnter"
        && parameterTypes is { Length: 1 }
        && parameterTypes[0] == typeof(StardewValley.Menus.TextBox)
        && parameterNames is { Length: 1 }
        && parameterNames[0] == "sender";

    /// <summary>
    /// The observer is activated only after the Host role has been accepted.
    /// GameLaunched is too early: the launcher writes the controlled profile
    /// before process start, but SMAPI may invoke subscribers before the Mod
    /// has completed role validation and lifecycle setup.
    /// </summary>
    internal static bool CanInstallForHostRole(bool hostRoleConfigured, bool hostProvisionerAvailable) =>
        hostRoleConfigured && hostProvisionerAvailable;

    /// <summary>
    /// Stardew passes the registered command name as the sole element for a
    /// bare command. Arguments are rejected; /stop is never a text shortcut.
    /// </summary>
    internal static bool IsBareStopCommand(string[]? command) =>
        command is { Length: 1 } && command[0] == "stop";

    /// <summary>
    /// Ordinary submitted text needs only the installed postfix observer. A
    /// collision on the reserved bare <c>/stop</c> command must disable that
    /// command only; it must not silently turn off non-command chat ingress.
    /// </summary>
    internal static bool CanPublishPlayerInput(bool nativeChatObservationInstalled) => nativeChatObservationInstalled;

    /// <summary>STOP needs both the observation surface and its exact registered command.</summary>
    internal static bool CanPublishStopAll(bool nativeChatObservationInstalled, bool stopCommandRegistered) =>
        nativeChatObservationInstalled && stopCommandRegistered;

    /// <summary>
    /// A native connection alone cannot receive SMAPI ModMessages. The bound
    /// remote peer must have completed SMAPI context exchange and advertise
    /// the exact receiving Mod; otherwise SMAPI silently filters a send.
    /// </summary>
    internal static bool CanRoutePlayerControlToBoundFarmhand(
        bool peerExists,
        bool peerHasSmapi,
        IEnumerable<string>? peerModIds,
        string? receivingModId) =>
        peerExists
        && peerHasSmapi
        && peerModIds is not null
        && !string.IsNullOrWhiteSpace(receivingModId)
        && peerModIds.Contains(receivingModId, StringComparer.Ordinal);
}
