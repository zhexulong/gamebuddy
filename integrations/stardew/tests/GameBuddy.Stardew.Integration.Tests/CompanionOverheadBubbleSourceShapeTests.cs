using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The companion's line has to reach the player through the world, not only through the corner log.
///
/// Before this pin, <c>TrySendCompanionPresentation</c> ended at the native chat write, so every line she
/// spoke landed in the chat box and nowhere else: a player looking at the farmer saw her face the player and
/// emote, and then had to look away to read what she said.
///
/// WHY SOURCE SHAPE AND NOT BEHAVIOUR. The seam this pins cannot run in a test process at all: it needs
/// <c>Game1.currentLocation</c> (null outside a loaded world), a populated <c>Game1.multiplayer</c> (the engine's
/// own static, absent in the runner) and a live SpriteBatch for the draw. So the pins below read the Mod's source
/// with comments stripped - a comment cannot satisfy them - and the decompiled reference for the engine facts.
///
/// WHY NOT <c>showTextAboveHead</c>. That method is the obvious one and it does not exist where the brief expected
/// it: on the target version it is declared only by <c>NPC</c> (reflection over the installed assembly finds two
/// declarations, <c>NPC</c> and <c>DebugCommands</c>), and the companion is a <c>Farmer</c>, whose whole
/// <c>*AboveHead*</c> member count is zero. The engine's own way to put text over an arbitrary character - the
/// path its calico-statue text uses - is a <c>TemporaryAnimatedSprite</c> carrying <c>text</c> with
/// <c>extraInfoForEndBehavior = -777</c>, which <c>TemporaryAnimatedSprite.draw</c> renders through
/// <c>SpriteText.drawString</c>.
/// </summary>
[Trait("kind", "source-shape")]
public sealed class CompanionOverheadBubbleSourceShapeTests
{
    private const string RepositoryRelativeRoot = "../../../../../../../";
    private const string DecompiledRelativeRoot = @"ref\external\StardewValleyDecompiled\Stardew Valley";

    private static string ReadRepositoryFile(string relativePath) =>
        File.ReadAllText(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, RepositoryRelativeRoot, relativePath)));

    private static string ReadModEntry() => StripLineComments(ReadRepositoryFile(Path.Combine("integrations", "stardew", "ModEntry.cs")));

    [Fact]
    public void ThePresentationDrawsTheBubbleAndStillWritesTheChatLine()
    {
        string presentation = MethodBody(ReadModEntry(), "private bool TrySendCompanionPresentation(");

        int bubble = presentation.IndexOf("this.TryShowCompanionBubble(", StringComparison.Ordinal);
        int chat = presentation.IndexOf("this.TrySendNativeChat(", StringComparison.Ordinal);

        bubble.Should().BeGreaterThanOrEqualTo(0, "the in-world bubble is what makes the line reach a player who is looking at the farmer");
        chat.Should().BeGreaterThanOrEqualTo(0, "the chat line is the log: it persists for scroll-back and reaches the whole lobby");
        // The bubble is attempted before the log write, and the log write is still what the receipt attests.
        bubble.Should().BeLessThan(chat, "the bubble is presentation and the chat write is the delivery the receipt attests; the bubble must not replace it");
        presentation.Should().Contain("return this.TrySendNativeChat(", "the chat write stays the method's return value, so a failed bubble cannot silently become the delivery outcome");
    }

    [Fact]
    public void TheBubbleIsTheEnginesOwnTextSpriteBroadcast()
    {
        string bubble = BubbleSource(ReadModEntry());

        // The engine's own text marker: TemporaryAnimatedSprite.draw routes this to SpriteText.drawString.
        bubble.Should().Contain("extraInfoForEndBehavior = -777");
        // Above-front, or the text is drawn underneath the world it is announcing.
        bubble.Should().Contain("drawAboveAlwaysFront = true");
        // The engine's own broadcast is the sync path (temporarySprites is a plain list, so there is no net state
        // to mirror), and it decides the server/client branches itself - the Mod must not reproduce them.
        bubble.Should().Contain("multiplayer.broadcastSprites(");
        bubble.Should().NotContain("Game1.client");
        bubble.Should().NotContain("Game1.server");
        bubble.Should().NotContain("sendMessage(");
        // The text branch of TemporaryAnimatedSprite.draw ignores attachedCharacter, so attaching the farmer would
        // only add a cross-process player lookup with nothing to draw differently.
        bubble.Should().NotContain("attachedCharacter");
    }

    [Fact]
    public void TheBubbleCannotBeReachedThroughTheNpcOnlySeam()
    {
        // NEGATIVE, and the reason the seam above exists at all: on the target version showTextAboveHead is
        // declared by NPC only. A `farmhand.showTextAboveHead(...)` would not compile, and a version of this code
        // that reached for it would be reaching for a method a Farmer does not have.
        ReadModEntry().Should().NotContain("showTextAboveHead");

        AssertLinesContain(Path.Combine(DecompiledRelativeRoot, "StardewValley", "NPC.cs"), new (int Line, string Fragment)[]
        {
            (1372, "public void showTextAboveHead(string text, Color? spriteTextColor = null, int style = 2, int duration = 3000, int preTimer = 0)"),
        });
    }

    [Fact]
    public void TheBubbleObeysTheSameIdentityLocaleAndEgressAuthorityAsTheChatLine()
    {
        string bubble = BubbleSource(ReadModEntry());

        // The identity gate: the companion must be the bound human recipient before anything is presented.
        bubble.Should().Contain("NativeChatPresentationPolicy.IsBoundHumanRecipient(farmhand)");
        // The locale gate: a line the client cannot render in its language is not presented at all.
        bubble.Should().Contain("NativeChatPresentationPolicy.IsCurrentLocale(locale)");
        // The egress gate: the exact static Game1.multiplayer field with the exact native type. The field is
        // protected internal, so there is no direct access to gate - only this identity check.
        bubble.Should().Contain("NativeChatPresentationPolicy.IsExactMultiplayerField(field)");
        bubble.Should().Contain("is not Multiplayer multiplayer");
        bubble.Should().NotContain("Game1.multiplayer", "the field is protected internal; reaching it any other way than the identity-checked reflection fails the build or bypasses the gate");
    }

    [Fact]
    public void TheBubbleLivesForTheVanillaOverheadDuration()
    {
        string source = ReadModEntry();

        source.Should().Contain("CompanionBubbleDurationMs = 3000;", "the duration is NPC.showTextAboveHead's own default");
        // One duration, two spellings would drift. The sprite's interval and its loop count are adjacent
        // arguments derived from the same pair of constants, so interval * loops is exactly the duration.
        // Whitespace is collapsed first: this is an assertion about the arguments, not about the layout.
        string bubble = System.Text.RegularExpressions.Regex.Replace(BubbleSource(source), @"\s+", " ");
        bubble.Should().Contain("CompanionBubbleDurationMs / (float)CompanionBubbleTicks, 1, CompanionBubbleTicks,");
    }

    // -----------------------------------------------------------------------------------------

    /// <summary>The bubble method, from its signature to the end of its body.</summary>
    private static string BubbleSource(string source) =>
        MethodBody(source, "private void TryShowCompanionBubble(") is { Length: > 0 } body
            ? body
            : throw new InvalidOperationException("the bubble presentation method must exist");

    private static void AssertLinesContain(string relative, IReadOnlyList<(int Line, string Fragment)> expected)
    {
        string path = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, RepositoryRelativeRoot, relative));
        File.Exists(path).Should().BeTrue($"the decompiled reference must exist at {relative}; re-derive the overhead-text seam against the target version before accepting this presentation path");
        string[] lines = File.ReadAllLines(path);

        foreach ((int line, string fragment) in expected)
        {
            int index = line - 1;
            if (index >= lines.Length || !lines[index].Contains(fragment, StringComparison.Ordinal))
                Assert.Fail($"decompiled {Path.GetFileName(relative)}:{line} no longer contains '{fragment}' -- the target version drifted; re-derive the overhead-text seam before accepting this presentation path.");
        }
    }

    /// <summary>Extract one member body by brace balance from its declaration.</summary>
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

        throw new InvalidOperationException($"unbalanced body for {declaration}");
    }

    /// <summary>Drop <c>//</c>/<c>///</c> comments so every pin above reads code and not prose.</summary>
    private static string StripLineComments(string source)
    {
        var builder = new System.Text.StringBuilder(source.Length);
        foreach (string line in source.Split('\n'))
        {
            int comment = line.IndexOf("//", StringComparison.Ordinal);
            builder.AppendLine(comment >= 0 ? line[..comment] : line);
        }
        return builder.ToString();
    }
}
