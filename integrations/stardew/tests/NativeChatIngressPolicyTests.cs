using GameBuddy.Stardew;

internal static class NativeChatIngressPolicyTests
{
    internal static void Run()
    {
        ExactRuntimeGate();
        HostRoleInstallGate();
        SubmittedTextGate();
        SubmittedTextClassificationGate();
        PatchTargetGate();
        FarmhandClientInitializationGate();
        StopCommandGate();
        StopConflictPreservesOrdinaryIngress();
        PlayerControlRouteGate();
    }

    private static void ExactRuntimeGate()
    {
        Assert(NativeChatIngressPolicy.IsSupportedRuntime("1.6.15", 24356, "4.5.2", "1.6.15", 24356, "4.5.2"),
            "exact provisioned runtime must enable native chat ingress.");
        Assert(!NativeChatIngressPolicy.IsSupportedRuntime("1.6.16", 24356, "4.5.2", "1.6.15", 24356, "4.5.2"),
            "different game version must fail closed.");
        Assert(!NativeChatIngressPolicy.IsSupportedRuntime("1.6.15", 24357, "4.5.2", "1.6.15", 24356, "4.5.2"),
            "different game build must fail closed.");
        Assert(!NativeChatIngressPolicy.IsSupportedRuntime("1.6.15", 24356, "4.5.3", "1.6.15", 24356, "4.5.2"),
            "different SMAPI version must fail closed.");
    }

    private static void HostRoleInstallGate()
    {
        Assert(NativeChatIngressPolicy.CanInstallForHostRole(hostRoleConfigured: true, hostProvisionerAvailable: true),
            "only an accepted Host provisioning role may install native chat ingress.");
        Assert(!NativeChatIngressPolicy.CanInstallForHostRole(hostRoleConfigured: true, hostProvisionerAvailable: false),
            "native chat ingress must wait until Host provisioning is available.");
        Assert(!NativeChatIngressPolicy.CanInstallForHostRole(hostRoleConfigured: false, hostProvisionerAvailable: true),
            "a non-Host profile must never install the native chat observer.");
    }

    private static void SubmittedTextGate()
    {
        Assert(NativeChatIngressPolicy.IsOrdinarySubmittedText("Meet me at the mine."),
            "ordinary submitted native chat must be admissible.");
        Assert(!NativeChatIngressPolicy.IsOrdinarySubmittedText("\t "),
            "blank submitted text must remain native-chat-only.");
        Assert(!NativeChatIngressPolicy.IsOrdinarySubmittedText("/stop"),
            "slash commands must not duplicate as ordinary player input.");
        Assert(!NativeChatIngressPolicy.IsOrdinarySubmittedText(new string('x', PlayerControlProtocol.MaximumTextLength + 1)),
            "oversized submitted text must fail closed.");
    }

    private static void SubmittedTextClassificationGate()
    {
        Assert(NativeChatIngressPolicy.ClassifySubmittedText("你好") == NativeChatIngressTextClassification.Ordinary,
            "submitted Chinese text must be classified as ordinary without retaining its body.");
        Assert(NativeChatIngressPolicy.ClassifySubmittedText(" \t") == NativeChatIngressTextClassification.FilteredBlank,
            "blank submitted text must have an exact redacted classification.");
        Assert(NativeChatIngressPolicy.ClassifySubmittedText("/stop") == NativeChatIngressTextClassification.FilteredCommand,
            "slash commands must have an exact redacted classification.");
        Assert(NativeChatIngressPolicy.ClassifySubmittedText(new string('x', PlayerControlProtocol.MaximumTextLength + 1)) == NativeChatIngressTextClassification.FilteredOversize,
            "oversized submitted text must have an exact redacted classification.");
    }

    private static void PatchTargetGate()
    {
        Assert(NativeChatIngressPolicy.IsTextSubmitPostfix("StardewValley.Menus.ChatBox", "textBoxEnter", new[] { typeof(string) }, new[] { "text_to_send" }, isPostfix: true),
            "only the exact named ChatBox string submit postfix may publish text.");
        System.Reflection.ParameterInfo[]? textPostfixParameters = typeof(ModEntry)
            .GetMethod("NativeChatTextBoxEnterPostfix", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic)
            ?.GetParameters();
        Assert(textPostfixParameters is { Length: 1 }
            && textPostfixParameters[0].Name == "text_to_send"
            && textPostfixParameters[0].ParameterType == typeof(string),
            "the text-publishing Harmony postfix must bind the pinned target parameter name text_to_send.");
        Assert(NativeChatIngressPolicy.IsTextBoxDelegatePrefix("StardewValley.Menus.ChatBox", "textBoxEnter", new[] { typeof(StardewValley.Menus.TextBox) }, new[] { "sender" }, isPrefix: true),
            "only the exact named ChatBox TextBox delegate prefix may provide redacted reachability diagnostics.");
        System.Reflection.ParameterInfo[]? delegatePrefixParameters = typeof(ModEntry)
            .GetMethod("NativeChatTextBoxEnterDelegatePrefix", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic)
            ?.GetParameters();
        Assert(delegatePrefixParameters is { Length: 1 }
            && delegatePrefixParameters[0].Name == "sender"
            && delegatePrefixParameters[0].ParameterType == typeof(StardewValley.Menus.TextBox),
            "the diagnostic prefix must bind only the target TextBox sender and never a text parameter.");
        Assert(!NativeChatIngressPolicy.IsTextSubmitPostfix("StardewValley.Menus.ChatBox", "textBoxEnter", new[] { typeof(string) }, new[] { "text" }, isPostfix: true),
            "a text target parameter name drift must fail closed.");
        Assert(!NativeChatIngressPolicy.IsTextBoxDelegatePrefix("StardewValley.Menus.ChatBox", "textBoxEnter", new[] { typeof(StardewValley.Menus.TextBox) }, new[] { "text_to_send" }, isPrefix: true),
            "a delegate target parameter name drift must fail closed.");
        Assert(!NativeChatIngressPolicy.IsTextSubmitPostfix("StardewValley.Menus.ChatBox", "textBoxEnter", Array.Empty<Type>(), Array.Empty<string>(), isPostfix: true),
            "another overload must fail closed for text publication.");
        Assert(!NativeChatIngressPolicy.IsTextBoxDelegatePrefix("StardewValley.Menus.ChatBox", "textBoxEnter", new[] { typeof(string) }, new[] { "text_to_send" }, isPrefix: true),
            "the diagnostic delegate prefix must not target string submitted text.");
        Assert(!NativeChatIngressPolicy.IsTextSubmitPostfix("StardewValley.Menus.ChatBox", "textBoxEnter", new[] { typeof(string) }, new[] { "text_to_send" }, isPostfix: false),
            "prefix patch must fail closed.");
    }

    private static void FarmhandClientInitializationGate()
    {
        System.Reflection.MethodInfo? factory = typeof(FarmhandProvisioner).GetMethod(
            "TryCreateInitializedNativeClient",
            System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic);
        Assert(factory is not null && factory.ReturnType == typeof(bool)
            && factory.GetParameters() is { Length: 2 } parameters
            && parameters[0].ParameterType == typeof(string)
            && parameters[1].IsOut
            && parameters[1].ParameterType == typeof(StardewValley.Network.LidgrenClient).MakeByRefType(),
            "formal Farmhand provisioning must expose only the fail-closed initialized-native-client factory.");
    }

    private static void StopCommandGate()
    {
        Assert(NativeChatIngressPolicy.IsBareStopCommand(new[] { "stop" }),
            "bare stop command must be accepted.");
        Assert(!NativeChatIngressPolicy.IsBareStopCommand(new[] { "stop", "now" }),
            "stop command arguments must fail closed.");
        Assert(NativeChatIngressPolicy.CanPublishPlayerInput(true),
            "an installed submit-only observer must continue admitting ordinary player input.");
        Assert(!NativeChatIngressPolicy.CanPublishPlayerInput(false),
            "missing submit-only observer must reject ordinary player input.");
        Assert(NativeChatIngressPolicy.CanPublishStopAll(true, true),
            "STOP needs both the observer installation and exact command registration.");
        Assert(!NativeChatIngressPolicy.CanPublishStopAll(false, true),
            "a command registration alone must never publish STOP.");
    }

    private static void PlayerControlRouteGate()
    {
        const string modId = "zhexulong.GameBuddy.Stardew";
        Assert(!NativeChatIngressPolicy.CanRoutePlayerControlToBoundFarmhand(false, false, null, modId),
            "missing Farmhand peer must reject player-control transport.");
        Assert(!NativeChatIngressPolicy.CanRoutePlayerControlToBoundFarmhand(true, false, Array.Empty<string>(), modId),
            "a native-connected vanilla Farmhand must reject player-control transport.");
        Assert(!NativeChatIngressPolicy.CanRoutePlayerControlToBoundFarmhand(true, true, new[] { "other.mod" }, modId),
            "a SMAPI Farmhand without the exact target Mod must reject player-control transport.");
        Assert(NativeChatIngressPolicy.CanRoutePlayerControlToBoundFarmhand(true, true, new[] { modId }, modId),
            "only a SMAPI Farmhand advertising the exact target Mod may receive player-control transport.");
    }

    private static void StopConflictPreservesOrdinaryIngress()
    {
        const bool observationInstalled = true;
        const bool stopCommandRegistered = false; // bare /stop already belongs to another command.

        Assert(NativeChatIngressPolicy.CanPublishPlayerInput(observationInstalled),
            "a bare /stop conflict must not disable the exact ChatBox.textBoxEnter(string) observer.");
        Assert(!NativeChatIngressPolicy.CanPublishStopAll(observationInstalled, stopCommandRegistered),
            "a bare /stop conflict must continue to fail closed for STOP publication.");
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
