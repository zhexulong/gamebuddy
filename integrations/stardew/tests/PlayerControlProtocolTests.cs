using GameBuddy.Stardew;

internal static class PlayerControlProtocolTests
{
    internal static void Run()
    {
        BridgeScope scope = new("stardew", "save", "world", "farmhand", "companion");
        PlayerControlModMessage input = new("message_1", "host", scope, "player_input", "control_1", "source_1", "Head to the mine.", "en-US");
        Assert(PlayerControlProtocol.IsValid(input, out _), "bounded player input must be valid.");
        Assert(!PlayerControlProtocol.IsValid(input with { Text = "" }, out _), "empty player input must fail closed.");
        Assert(!PlayerControlProtocol.IsValid(input with { Text = " \t" }, out _), "whitespace player input must fail closed.");
        Assert(!PlayerControlProtocol.IsValid(input with { Scope = scope with { IntegrationId = "other" } }, out _), "foreign integration scope must fail closed.");
        PlayerControlModMessage stop = new("message_2", "host", scope, "stop_all", "control_2", "source_2", null, "en-US");
        Assert(PlayerControlProtocol.IsValid(stop, out _), "text-free stop_all must be valid.");
        Assert(!PlayerControlProtocol.IsValid(stop with { Text = "unexpected" }, out _), "stop_all text must fail closed.");
        var replay = new PlayerControlReplayGuard();
        Assert(replay.TryConsume("message_1"), "first message must be consumed.");
        Assert(!replay.TryConsume("message_1"), "duplicate message must be rejected.");
        for (int index = 0; index < 2_000; index++)
            Assert(replay.TryConsume($"message_{index + 3}"), "distinct control messages must be consumable for the live session.");
        Assert(replay.Contains("message_1"), "old live-session control identities must not be evicted.");

        Assert(NativeChatIngressPolicy.IsSupportedRuntime("1.6.15", 24356, "4.5.2", "1.6.15", 24356, "4.5.2"), "exact provisioned target runtime must enable the native chat observation policy.");
        Assert(!NativeChatIngressPolicy.IsSupportedRuntime("1.6.16", 24356, "4.5.2", "1.6.15", 24356, "4.5.2"), "other game versions must fail closed.");
        Assert(!NativeChatIngressPolicy.IsSupportedRuntime("1.6.15", 24357, "4.5.2", "1.6.15", 24356, "4.5.2"), "other game builds must fail closed.");
        Assert(!NativeChatIngressPolicy.IsSupportedRuntime("1.6.15", 24356, "4.5.3", "1.6.15", 24356, "4.5.2"), "other SMAPI versions must fail closed.");
        Assert(!NativeChatIngressPolicy.IsSupportedRuntime("1.6.15", 24356, "4.5.2", "1.6.16", 24356, "4.5.2"), "a mismatched provisioned game target must fail closed.");
        Assert(NativeChatIngressPolicy.IsOrdinarySubmittedText("Head to the mine."), "ordinary submitted chat must be admissible.");
        Assert(!NativeChatIngressPolicy.IsOrdinarySubmittedText("  \t"), "blank submitted chat must remain local only.");
        Assert(!NativeChatIngressPolicy.IsOrdinarySubmittedText("/stop"), "slash commands must never duplicate into ordinary input.");
        Assert(!NativeChatIngressPolicy.IsOrdinarySubmittedText(new string('x', PlayerControlProtocol.MaximumTextLength + 1)), "oversized submitted chat must fail closed.");
        Assert(NativeChatIngressPolicy.IsTextSubmitPostfix("StardewValley.Menus.ChatBox", "textBoxEnter", new[] { typeof(string) }, new[] { "text_to_send" }, isPostfix: true), "only the exact named target ChatBox string submit postfix may publish text.");
        Assert(!NativeChatIngressPolicy.IsTextSubmitPostfix("StardewValley.Menus.ChatBox", "textBoxEnter", new[] { typeof(string) }, new[] { "text" }, isPostfix: true), "a text target parameter-name drift must fail closed.");
        Assert(!NativeChatIngressPolicy.IsTextSubmitPostfix("StardewValley.Menus.ChatBox", "textBoxEnter", Array.Empty<Type>(), Array.Empty<string>(), isPostfix: true), "another ChatBox overload must fail closed for text publication.");
        Assert(!NativeChatIngressPolicy.IsTextSubmitPostfix("StardewValley.Menus.ChatBox", "textBoxEnter", new[] { typeof(string) }, new[] { "text_to_send" }, isPostfix: false), "a prefix must fail closed.");
        Assert(NativeChatIngressPolicy.IsTextBoxDelegatePrefix("StardewValley.Menus.ChatBox", "textBoxEnter", new[] { typeof(StardewValley.Menus.TextBox) }, new[] { "sender" }, isPrefix: true), "the exact TextBox delegate overload may provide only reachability diagnostics.");
        Assert(!NativeChatIngressPolicy.IsTextBoxDelegatePrefix("StardewValley.Menus.ChatBox", "textBoxEnter", new[] { typeof(string) }, new[] { "text_to_send" }, isPrefix: true), "the diagnostic delegate prefix must never bind submitted text.");
        Assert(NativeChatIngressPolicy.CanPublishPlayerInput(true), "an installed native chat observer may publish ordinary player input.");
        Assert(!NativeChatIngressPolicy.CanPublishPlayerInput(false), "a missing native chat observer must not publish player input.");
        Assert(NativeChatIngressPolicy.CanPublishStopAll(true, true), "STOP needs both the observer and its exact registered command.");
        Assert(!NativeChatIngressPolicy.CanPublishStopAll(true, false), "a command collision must fail closed for STOP only.");
        Assert(NativeChatIngressPolicy.IsBareStopCommand(new[] { "stop" }), "bare stop command must be accepted.");
        Assert(new[] { "ai_player_control_pipe_enqueued", "ai_player_control_pipe_flushed", "ai_player_control_pipe_write_failed", "ai_player_control_pipe_flush_unconfirmed" }.Distinct().Count() == 4,
            "native-chat pipe diagnostic stages must remain distinct and content-free.");
        Assert(!NativeChatIngressPolicy.IsBareStopCommand(new[] { "stop", "later" }), "stop arguments must fail closed.");
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition)
            throw new InvalidOperationException(message);
    }
}
