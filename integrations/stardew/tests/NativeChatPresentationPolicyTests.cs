using GameBuddy.Stardew;
using StardewValley;
using System.Reflection;

internal static class NativeChatPresentationPolicyTests
{
    internal static void Run()
    {
        Type game = typeof(Game1);
        Assert(NativeChatPresentationPolicy.IsExactMultiplayerField(game.GetField("multiplayer", BindingFlags.Static | BindingFlags.NonPublic)),
            "only the exact Game1 private static Multiplayer field may be used for egress.");
        Assert(!NativeChatPresentationPolicy.IsExactMultiplayerField(game.GetField("version", BindingFlags.Static | BindingFlags.Public)),
            "any other reflected member must fail closed.");
        Assert(NativeChatPresentationPolicy.CanonicalBcp47Locale("en", "") == "en-US",
            "English must use the Host BCP-47 grammar, not the native enum label.");
        Assert(NativeChatPresentationPolicy.CanonicalBcp47Locale("zh", "zh-CN") == "zh-CN",
            "Chinese must retain the exact native BCP-47 locale.");
        Assert(NativeChatPresentationPolicy.CanonicalBcp47Locale("pt", "pt-BR") == "pt-BR",
            "Portuguese must retain the exact native BCP-47 locale.");
        Assert(NativeChatPresentationPolicy.CanonicalBcp47Locale("mod", "not a locale") == "",
            "invalid custom locales must fail closed.");
        Assert(NativeChatPresentationPolicy.IsFixtureLiveLocaleAvailable("", "en-US"),
            "ordinary fixtures must remain outside the Preview locale gate.");
        Assert(NativeChatPresentationPolicy.IsFixtureLiveLocaleAvailable("zh-CN", "zh-CN"),
            "the Preview fixture gate must accept the exact live zh-CN locale.");
        Assert(!NativeChatPresentationPolicy.IsFixtureLiveLocaleAvailable("zh-CN", ""),
            "an unavailable live locale must block Preview readiness.");
        Assert(!NativeChatPresentationPolicy.IsFixtureLiveLocaleAvailable("zh-CN", "zh"),
            "a native preference-style zh label is not the required live BCP-47 locale.");
        Assert(NativeChatPresentationPolicy.IsFixtureLiveLocaleAvailable("en-US", "en-US"),
            "the Preview fixture gate must accept the exact live en-US locale.");
        Assert(!NativeChatPresentationPolicy.IsFixtureLiveLocaleAvailable("en-US", "zh-CN"),
            "a different release-verified locale must not satisfy the exact fixture gate.");
        Assert(!NativeChatPresentationPolicy.IsFixtureLiveLocaleAvailable("ja-JP", "ja-JP"),
            "unsupported Preview locale requirements must fail closed.");
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
