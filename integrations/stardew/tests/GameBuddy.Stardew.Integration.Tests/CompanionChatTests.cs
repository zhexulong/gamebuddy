using FluentAssertions;
using StardewModdingAPI;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The player has one way to say something to the companion, and before this lane nothing told them where it was: the
/// Mod bound no key, and the engine's chat box - the surface the whole text ingress hangs off - was reachable only by
/// knowing vanilla multiplayer's own chat key.
///
/// <para>
/// WHAT WAS MEASURED FIRST (companion-chat probe, real 1.6.15 single-player fixture session, 2026-11-13): calling
/// <c>Game1.chatBox.activate()</c> leaves <c>chatBox.isActive()==true</c> with <c>Game1.keyboardDispatcher.Subscriber</c>
/// set to <c>StardewValley.Menus.ChatTextBox</c>, and text driven through that subscriber
/// (<c>RecieveTextInput</c> per character, then <c>RecieveCommandInput('\r')</c>) reaches
/// <c>ChatBox.textBoxEnter(string)</c> with exactly the typed text - the submit seam this Mod's Harmony postfix already
/// observes - and the box closes itself. The engine's own chat box is therefore a working companion input in
/// single-player. The probe's OS-keystroke half could not be measured: <c>SetForegroundWindow</c> was refused
/// (<c>false</c>, foreground handle != the game's), so real keystrokes never reached the process; that hop is shared with
/// every vanilla text field and is not what this unit decides.
/// </para>
///
/// <para>
/// What CAN be pinned without a game: the key policy, the words the player reads, the gate that decides when the box may
/// be opened, and the wiring itself (a runner cannot press a key or draw a frame).
/// </para>
/// </summary>
public sealed class CompanionChatTests
{
    private const string RepositoryRelativeRoot = "../../../../../../../";

    // ── the key ──────────────────────────────────────────────────────────────────────────

    [Theory]
    [InlineData("h")]
    [InlineData("H")]
    [InlineData("Y")]
    public void TheCompanionKeyIsWhateverTheProfileSaysInEitherCase(string configured)
    {
        CompanionChat.TryParseOpenKey(configured, out SButton button, out string reason).Should().BeTrue(reason);
        button.Should().Be(Enum.Parse<SButton>(configured, ignoreCase: true));
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("NoSuchButton")]
    [InlineData("None")]
    public void AKeyThatIsNotAKeyIsRefusedByName(string configured)
    {
        CompanionChat.TryParseOpenKey(configured, out SButton button, out string reason).Should().BeFalse();
        reason.Should().Be("companion_chat_key_invalid");
        button.Should().Be(SButton.None, "a refused key must not leave a binding behind");
    }

    [Fact]
    public void VanillasOwnChatKeyIsNotBoundTwiceToTheSameBox()
    {
        // T already opens this exact box (Game1.UpdateChatBox -> options.chatButton), so binding it here would claim a
        // second meaning for one keystroke: refreshing nothing, and turning off the vanilla path's own behaviour.
        CompanionChat.TryParseOpenKey("T", out _, out string reason).Should().BeFalse();
        reason.Should().Be("companion_chat_key_reserved");
    }

    // ── the words ────────────────────────────────────────────────────────────────────────

    [Fact]
    public void TheTitleSaysWhoseInputItIsRatherThanChat()
    {
        string title = CompanionChat.TitleText("琥珀", "zh-CN");

        title.Should().Contain("琥珀", "the player has to be told who they are typing to");
        title.Should().NotBe("Chat", "the engine's own label is the multiplayer channel, not her");
        CompanionChat.TitleText("Amber", "en-US").Should().Contain("Amber");
    }

    [Fact]
    public void TheHintNamesTheKeyAndThatSheIsStandingHere()
    {
        string hint = CompanionChat.HintText("琥珀", "H", "zh-CN");

        hint.Should().Contain("H", "a hint that does not name the key leaves the player where they were");
        hint.Should().Contain("琥珀");
        CompanionChat.HintText("Amber", "H", "en-US").Should().Contain("H").And.Contain("Amber");
    }

    [Fact]
    public void ALocaleTheModCannotSpeakFallsBackToEnglishRatherThanToNothing()
    {
        CompanionChat.TitleText("Amber", "").Should().Contain("Amber");
        CompanionChat.HintText("Amber", "H", "cy-GB").Should().Contain("H");
    }

    // ── when it may open ─────────────────────────────────────────────────────────────────

    [Fact]
    public void TheBoxOpensOnlyWhereAPlayerIsActuallyStandingInTheWorld()
    {
        CompanionChat.CanOpen(worldReady: true, alreadyActive: false, otherTextInputOwnsKeyboard: false, menuOpen: false, eventRunning: false)
            .Should().BeTrue("plain world play is the one place a companion line can be typed");
    }

    [Theory]
    [InlineData(false, false, false, false, false)]
    [InlineData(true, true, false, false, false)]
    [InlineData(true, false, true, false, false)]
    [InlineData(true, false, false, true, false)]
    [InlineData(true, false, false, false, true)]
    public void EveryPlaceTheBoxMayNotOpenIsNamedAndRefused(
        bool worldReady,
        bool alreadyActive,
        bool otherTextInputOwnsKeyboard,
        bool menuOpen,
        bool eventRunning)
    {
        CompanionChat.CanOpen(worldReady, alreadyActive, otherTextInputOwnsKeyboard, menuOpen, eventRunning).Should().BeFalse();
    }

    [Fact]
    public void AnotherTextBoxKeepingTheKeyboardIsNotOverridden()
    {
        // Game1.UpdateChatBox refuses to activate while a subscriber exists, for the same reason: a naming menu or a
        // sign edit owns what the player types, and stealing it would type their words into her conversation instead.
        CompanionChat.CanOpen(true, false, otherTextInputOwnsKeyboard: true, menuOpen: false, eventRunning: false)
            .Should().BeFalse();
    }

    // ── the wiring ───────────────────────────────────────────────────────────────────────

    [Fact]
    public void TheModBindsAKeyAndOpensTheEnginesOwnBoxWithIt()
    {
        string modEntry = StripLineComments(ReadRepositoryFile(Path.Combine("integrations", "stardew", "ModEntry.cs")));

        AssertPresent(modEntry, "helper.Events.Input.ButtonPressed +=", "a key nobody subscribes to is a key nobody can press");
        AssertPresent(modEntry, "Game1.chatBox.activate()", "the engine's own chat box is the input; there is no second text field");
        AssertPresent(modEntry, "this.Helper.Input.Suppress(", "the bound key must not also do whatever else it keybinds");
    }

    [Fact]
    public void TheArrivalHintIsOneEngineNotificationThatCannotRepeat()
    {
        string modEntry = StripLineComments(ReadRepositoryFile(Path.Combine("integrations", "stardew", "ModEntry.cs")));
        string hint = MethodBody(modEntry, "private void MaybeShowCompanionChatHint(");

        AssertPresent(hint, "Game1.addHUDMessage(new HUDMessage(", "the hint is the engine's own notification, not a panel we cut out");
        int guard = hint.IndexOf("this.companionChatHintShown = true;", StringComparison.Ordinal);
        int show = hint.IndexOf("Game1.addHUDMessage(", StringComparison.Ordinal);
        guard.Should().BeGreaterThanOrEqualTo(0, "a hint without a one-time guard is a hint every second");
        guard.Should().BeLessThan(show, "the guard has to be set before the message, or a re-entrant tick repeats it");
    }

    [Fact]
    public void TheTitleIsDrawnByTheEnginesOwnRoutineAboveItsOwnBox()
    {
        string modEntry = StripLineComments(ReadRepositoryFile(Path.Combine("integrations", "stardew", "ModEntry.cs")));
        string draw = MethodBody(modEntry, "private void DrawCompanionChatTitle(");

        AssertPresent(draw, "chat.isActive()", "a title over a box nobody is typing in is a label on nothing");
        AssertPresent(draw, "CompanionChat.TitleText(", "the drawn words are the title the rest of the Mod reasons about");
        AssertPresent(draw, "Utility.drawTextWithShadow(", "the engine's own text routine, not a hand-drawn glyph path");
        AssertPresent(modEntry, "AccessTools.Method(typeof(ChatBox), \"draw\"", "the title hangs off the engine's own draw of that box");
    }

    // ── helpers ──────────────────────────────────────────────────────────────────────────

    private static string ReadRepositoryFile(string relativePath) =>
        File.ReadAllText(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, RepositoryRelativeRoot, relativePath)));

    private static void AssertPresent(string source, string fragment, string why)
    {
        if (source.Contains(fragment, StringComparison.Ordinal))
            return;
        Assert.Fail($"'{fragment}' is not in the source: {why}");
    }

    private static string MethodBody(string source, string declaration)
    {
        int start = source.IndexOf(declaration, StringComparison.Ordinal);
        if (start < 0)
            return string.Empty;
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
        return source[start..];
    }

    private static string StripLineComments(string source)
    {
        System.Text.StringBuilder builder = new(source.Length);
        foreach (string line in source.Split('\n'))
        {
            int comment = line.IndexOf("//", StringComparison.Ordinal);
            builder.AppendLine(comment >= 0 ? line[..comment] : line);
        }
        return builder.ToString();
    }
}
