using System.Globalization;
using FluentAssertions;
using Microsoft.Xna.Framework;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The companion's line has to reach the player through the world, not only through the corner log.
///
/// Before this pin, <c>TrySendCompanionPresentation</c> ended at the native chat write, so every line she spoke landed
/// in the chat box and nowhere else: a player looking at the farmer saw her face the player and emote, and then had to
/// look away to read what she said.
///
/// WHAT IT IS NOW. The engine's own bubble box - its 9-slice panel and its pointer, the geometry behind the game's own
/// small speech bubbles (<c>PetBowl.cs:137</c>, <c>Object.cs:5494</c>, <c>DayTimeMoneyBox.cs:539</c>) - with the glyphs
/// drawn in the dialogue face, because that routine is <c>Game1.smallFont</c> end to end and a spoken line in the
/// pet-name font was too small to read. The line crosses the wire as a ModMessage - the speaker's player id and the
/// text - and every client draws it in the engine's above-always-front layer from the speaker's own standing pixel.
///
/// WHY THE DRAW CANNOT BE A BEHAVIOUR TEST. The seam needs <c>Game1.currentLocation</c> (null outside a loaded world), a
/// live <c>SpriteBatch</c> and a drawn frame, none of which exists in a runner. What CAN be run without a game is the
/// board that owns a line's lifetime and the layout that sizes the box, and that is where the behaviour tests point.
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the board's lifetime and one-line-per-speaker rules run as real objects, while the draw
// path and the wire can only be pinned by reading the Mod's own source - the game's draw cannot run in a test process.
public sealed class CompanionBubbleTests
{
    private const string RepositoryRelativeRoot = "../../../../../../../";
    private const string DecompiledRelativeRoot = @"ref\external\StardewValleyDecompiled\Stardew Valley";

    // ---------------------------------------------------------------------------------------
    // Behaviour: the board that decides when a line is shown and when it is over.
    // ---------------------------------------------------------------------------------------

    [Fact]
    public void ALineIsShownUntilItsLifetimeIsUpAndNotOneMillisecondLonger()
    {
        CompanionBubbleBoard board = new();
        board.Show(42, "Meet me at the cabin.", nowMs: 1_000);

        board.Expire(1_000 + CompanionBubble.DurationMs - 1);
        board.Count.Should().Be(1, "the line is still inside its lifetime one millisecond before it ends");

        board.Expire(1_000 + CompanionBubble.DurationMs);
        board.Count.Should().Be(0, "the expiry is the first millisecond the line is over, so it cannot outlive its duration");
    }

    [Fact]
    public void ASecondLineReplacesTheFirstOverTheSameHead()
    {
        CompanionBubbleBoard board = new();
        board.Show(42, "first", 0);
        board.Show(42, "second", 500);

        board.Count.Should().Be(1, "one bubble per turn: a second line does not stack over the same speaker");
        board.Lines.Should().ContainSingle().Which.Text.Should().Be("second");
    }

    [Fact]
    public void TwoSpeakersKeepTheirOwnLinesAndEndOnTheirOwnClocks()
    {
        CompanionBubbleBoard board = new();
        board.Show(42, "hers", 0);
        board.Show(43, "theirs", 2_000);

        board.Expire(0 + CompanionBubble.DurationMs);
        board.Lines.Should().ContainSingle("only the line whose lifetime is up is dropped")
            .Which.SpeakerPlayerId.Should().Be(43);
        board.Lines.Should().ContainSingle().Which.Text.Should().Be("theirs");

        board.Expire(2_000 + CompanionBubble.DurationMs);
        board.Count.Should().Be(0);
    }

    [Fact]
    public void ALineThatWasReplacedDoesNotResurrectWhenTheReplacementEnds()
    {
        CompanionBubbleBoard board = new();
        board.Show(42, "first", 0);
        board.Show(42, "second", 2_500);

        // The replaced line's own expiry (3000) is passed here; the replacement (5500) must be the one still shown.
        board.Expire(3_000);
        board.Lines.Should().ContainSingle().Which.Text.Should().Be("second");
    }

    [Theory]
    [InlineData(0, "hello")]
    [InlineData(-7, "hello")]
    [InlineData(42, "")]
    [InlineData(42, " \t\n")]
    public void AMessageThatCouldNotBeALineIsRefused(long speakerPlayerId, string text)
    {
        CompanionBubbleMessage message = new(speakerPlayerId, text);

        CompanionBubble.IsValid(message, out string reasonCode).Should().BeFalse();
        reasonCode.Should().Be("companion_bubble_invalid");
        CompanionBubble.IsValid(null, out _).Should().BeFalse("an absent line is not a line");
    }

    [Fact]
    public void ALineAtTheWireBoundIsAcceptedAndOneCharacterPastItIsNot()
    {
        string atBound = new('x', CompanionBubble.MaxTextLength);
        CompanionBubble.IsValid(new CompanionBubbleMessage(42, atBound), out string accepted).Should().BeTrue();
        accepted.Should().Be("accepted");

        string pastBound = new('x', CompanionBubble.MaxTextLength + 1);
        CompanionBubble.IsValid(new CompanionBubbleMessage(42, pastBound), out _).Should().BeFalse(
            "the wire bound is the largest thing that can be a line");
    }

    // ---------------------------------------------------------------------------------------
    // Shape: the draw, the wire, and the mechanism that is gone.
    // ---------------------------------------------------------------------------------------

    [Fact]
    public void TheBubbleKeepsTheEngineNineSliceAndThePointerButNotItsFont()
    {
        string bubble = StripLineComments(ReadCompanionBubble());

        // The box and the tail are the engine's own geometry, copied from the routine this replaces: the same texture,
        // the same source rectangles, the same 4x scale (SpriteText.cs:456 for the 9-slice, :463 for the pointer).
        AssertPresent(bubble, "new Rectangle(241, 503, 9, 9)", "the box is the engine's 9-slice source tile, not a rectangle we assemble");
        AssertPresent(bubble, "new Rectangle(251, 506, 5, 5)", "the tail is the engine's own 5x5 tile, at the coordinates the small bubble draws it");
        AssertPresent(
            bubble,
            "IClickableMenu.drawTextureBox(",
            "the box is drawn by the engine's 9-slice routine, so corners, edges and scale are the game's and not ours");

        // ... but the glyphs are the dialogue face, parsed, measured and drawn with the SAME font: a panel sized by one
        // font and filled by another is text hanging out of the box.
        AssertPresent(bubble, "Game1.parseText(text, Game1.dialogueFont,", "a line is wrapped at the size it will be read at");
        AssertPresent(
            bubble,
            "MaxWidth - BubbleLayout.BoxPaddingX",
            "the engine's own inset is taken off before wrapping (SpriteText.cs:452 parses at maxWidth - 16), so the run cannot outgrow the box's padding");
        AssertPresent(bubble, "Game1.dialogueFont.MeasureString(line)", "the panel is sized from the font that draws it");
        AssertPresent(
            bubble,
            "Utility.drawTextWithShadow(batch, line, Game1.dialogueFont,",
            "the glyphs are the dialogue face a player already reads an NPC's line in");

        // And no other font may size or fill it. drawSmallTextBubble is smallFont end to end (SpriteText.cs:452 parses,
        // :455 measures, :465 draws) - the face the game uses for pet names and gold strings, which is why the line was
        // too small to read. Calling it again would reinstate exactly that.
        AssertAbsent(bubble, "smallFont", "smallFont is the font that made the line unreadable; the slice is reused, the face is not");
        AssertAbsent(
            bubble,
            "SpriteText.drawSmallTextBubble(",
            "the engine routine measures and draws with smallFont; this unit keeps its 9-slice and pointer and replaces its font");

        // The behaviour checked below is the behaviour this draw uses: the budget is what Draw clamps with, and the box,
        // run and tail are the layout's - not three coordinate sets that happen to look the same today.
        AssertPresent(bubble, "string line = ClampToLines(", "the run that is sized and drawn is the clamped one, or the budget is a number nobody applies");
        AssertPresent(
            bubble,
            "LinesThatFit(Game1.dialogueFont.LineSpacing, spriteHeight)",
            "the budget comes from the font that draws the line and from the speaker's own frame height");
        AssertPresent(bubble, "layout.Box.X", "the box drawn is the box the layout tests measure");
        AssertPresent(bubble, "layout.Text", "the run drawn is the run the layout tests place inside that box");
        AssertPresent(bubble, "layout.Pointer", "the tail drawn is the tail the layout tests centre on her head");
    }

    [Fact]
    public void TheAnchorIsHerHeadEveryFrame()
    {
        // The anchor is re-derived from the speaker every frame: she walks, and the box is drawn immediately around the
        // point it is handed, so nothing in it can follow her.
        string draw = MethodBody(StripLineComments(ReadModEntry()), "private void DrawCompanionBubbles(");
        AssertPresent(draw, "CompanionBubble.BottomCenter(speaker.StandingPixel, spriteHeight)", "the anchor is her head, now");
        AssertPresent(draw, "Game1.GlobalToLocal(", "the above-always-front batch is in screen pixels; a world pixel would land off-screen");
        AssertPresent(
            draw,
            "spriteHeight);",
            "the height her bubble may not outgrow is the same height the anchor lifts it by, read from her own sprite");
    }

    // ---------------------------------------------------------------------------------------
    // The box, the tail and the height budget: the engine's geometry, checked as geometry.
    // ---------------------------------------------------------------------------------------

    /// <summary>
    /// The measured runs below are the real dialogue face's own, read off the shipped <c>Fonts/SpriteFont1.zh-CN</c> with
    /// <c>SpriteFont.MeasureString</c>: one CJK glyph advances 25 px and a line is 42 px tall, so the round47 line
    /// 「鬓角全是汗，头发黏在颈侧，手背一抹黏糊糊的。」 is 425 x 84 at the 432-px wrap width - two lines. The same line in
    /// <c>Game1.smallFont</c> measures 397 x 30 as one line: that is the size difference this unit exists for, and why the
    /// box has to be sized by the face that fills it.
    /// </summary>
    [Theory]
    [InlineData(425f, 84f, "the round47 line at the wrap width: two dialogue lines")]
    [InlineData(175f, 42f, "a short line: one dialogue line")]
    [InlineData(450f, 84f, "a line cut at the budget, plus the ellipsis glyph")]
    [InlineData(25f, 42f, "a single glyph")]
    public void TheGlyphRunSitsInsideTheBoxItSized(float width, float height, string what)
    {
        Vector2 measured = new(width, height);
        Vector2 anchor = new(640f, 300f);
        BubbleLayout layout = BubbleLayout.For(anchor, measured);

        // The defect this replaces: a box sized for one face and filled with a larger one, so the glyphs hang out of it.
        layout.Text.X.Should().BeGreaterThanOrEqualTo(layout.Box.Left, $"the run starts inside the left edge for {what}");
        layout.Text.Y.Should().BeGreaterThanOrEqualTo(layout.Box.Top, $"the run starts below the top edge for {what}");
        (layout.Text.X + measured.X).Should().BeLessThanOrEqualTo(
            layout.Box.Right,
            $"the run ends inside the right edge for {what}: a box measured with a smaller face lets the text hang out");
        (layout.Text.Y + measured.Y).Should().BeLessThanOrEqualTo(
            layout.Box.Bottom,
            $"the run ends above the bottom edge for {what}: a box measured with a smaller face lets the text hang out");

        // The box hangs from the anchor and the tail is centred on it, so the bubble points at her head and not beside it.
        layout.Box.Bottom.Should().BeLessThanOrEqualTo((int)anchor.Y + BubbleLayout.BoxPaddingY, $"the box hangs above the anchor for {what}");
        (layout.Pointer.X + 5f * CompanionBubble.SpriteScale / 2f).Should().Be(
            anchor.X,
            $"the tail is centred on the anchor for {what}: the engine draws its 5x5 tile at 4x from the anchor");
    }

    [Fact]
    public void TheBoxCannotGrowTallerThanTheSpaceSheStandsIn()
    {
        // Every number here is the engine's, not ours: the dialogue face's line height, a Farmer's own frame height, and
        // the scale the bubble is drawn at.
        int lineSpacing = EngineInt("StardewValley/Game1.cs", 3104, "dialogueFont.LineSpacing = ", ";");
        int spriteHeight = EngineInt("StardewValley/FarmerSprite.cs", 564, "base.SpriteHeight = ", ";");
        int engineScale = EngineInt(
            Path.Combine("StardewValley.BellsAndWhistles", "SpriteText.cs"),
            463,
            "Vector2.Zero, ",
            ", SpriteEffects.None");
        CompanionBubble.SpriteScale.Should().Be(
            engineScale,
            "the box and tail are drawn at the engine's own scale, and the lift the budget divides by is that same scale");

        int lift = spriteHeight * CompanionBubble.SpriteScale;

        int lines = CompanionBubble.LinesThatFit(lineSpacing, spriteHeight);
        (lines * lineSpacing + BubbleLayout.BoxPaddingY).Should().BeLessThanOrEqualTo(
            lift,
            $"a box of {lines} dialogue lines must still fit the {lift} px the engine lifts overhead text by");
        ((lines + 1) * lineSpacing + BubbleLayout.BoxPaddingY).Should().BeGreaterThan(
            lift,
            "the budget is the LARGEST that fits, not merely a small number: one more line would climb above her");

        // And the layout that budget produces is the height the budget allows.
        BubbleLayout layout = BubbleLayout.For(new Vector2(0f, lift), new Vector2(100f, lines * lineSpacing));
        layout.Box.Height.Should().BeLessThanOrEqualTo(lift, "the box the draw builds for the allowed lines stays inside the space");

        CompanionBubble.LinesThatFit(lineSpacing, spriteHeight: 8).Should().Be(1, "a sprite too short for a line still shows the one line the line needs");
    }

    [Fact]
    public void ALineInsideTheBudgetIsShownWholeAndPastItIsCut()
    {
        string twoLines = "鬓角全是汗，头发黏在颈侧，" + Environment.NewLine + "手背一抹黏糊糊的。";
        CompanionBubble.ClampToLines(twoLines, 2).Should().Be(
            twoLines.Trim(),
            "a line the box can hold is not touched: the whole sentence she said reaches the world");

        string[] six =
        {
            "一", "二", "三", "四", "五", "六",
        };
        string cut = CompanionBubble.ClampToLines(string.Join(Environment.NewLine, six), 2);
        string[] kept = cut.Replace("\r\n", "\n").Split('\n');
        kept.Should().HaveCount(2, "the budget is the number of lines, not a suggestion");
        kept[0].Should().Be("一", "the cut keeps the wrapped run's own lines, in order - it invents nothing");
        kept[1].Should().Be("二" + CompanionBubble.Ellipsis, "the cut says so on the line it stops at");
        cut.Should().NotContain("三", "nothing past the budget is drawn; the chat write already carried the whole sentence");
    }

    [Fact]
    public void TheGeometryCopiedHereIsStillTheEnginesOwn()
    {
        // The box and the tail are copied from one routine: if the engine moves those tiles or changes the padding, this
        // copy is wrong, and the failure names the line to re-derive rather than drawing someone else's pixels.
        // The last two fragments are also the reason the routine is no longer CALLED: it measures (:455) and draws (:465)
        // with Game1.smallFont, the face that made a spoken line too small to read.
        AssertLinesContain(Path.Combine(DecompiledRelativeRoot, "StardewValley.BellsAndWhistles", "SpriteText.cs"), new (int Line, string Fragment)[]
        {
            (455, "Vector2 vector = Game1.smallFont.MeasureString(s);"),
            (456, "new Rectangle(241, 503, 9, 9)"),
            (463, "new Rectangle(251, 506, 5, 5)"),
            (465, "Utility.drawTextWithShadow(b, s, Game1.smallFont"),
        });
    }

    [Fact]
    public void NoPanelSpriteIsConstructedAnyMore()
    {
        string bubble = StripLineComments(ReadCompanionBubble());
        foreach (string gone in new[] { "PanelSourceRect", "PanelMarker", "PanelTextureName", "IsCompanionBubble", "TemporaryAnimatedSprite", "extraInfoForEndBehavior" })
            AssertAbsent(bubble, gone, "the panel was a right-angled rectangle the engine's bubble replaces; a leftover piece is the defect this unit removes");

        string mod = StripLineComments(ReadModEntry());
        foreach (string gone in new[] { "broadcastSprites(", "CompanionBubble.PanelSprite(", "CompanionBubble.TextSprite(", "FollowCompanionBubbles(" })
            AssertAbsent(mod, gone, "the sprite route is gone, so no call site may still reach it");

        // The panel's tile is not something to keep in a corner of the Mod for later: it is the pixel this unit exists to
        // stop cutting out, so it must not appear anywhere in the Mod's sources - derived from the tree, not from a list.
        foreach ((string path, string source) in ModSources())
        {
            AssertAbsent(source, "PanelSourceRect", $"{path} still names the panel's source rectangle");
            AssertAbsent(source, "244, 506", $"{path} still cuts the bubble's interior tile out of the vanilla box");
        }
    }

    [Fact]
    public void TheLineCrossesTheWireAndIsDrawnByEveryClient()
    {
        string mod = StripLineComments(ReadModEntry());
        string show = MethodBody(mod, "private void TryShowCompanionBubble(");

        AssertPresent(show, "this.companionBubbles.Show(", "SMAPI does not deliver a ModMessage to its own sender, so the client that owns her body shows the line itself - and that local half is what single-player draws");
        AssertPresent(show, "this.Helper.Multiplayer.SendMessage(", "the other clients can only draw what they are told");
        AssertPresent(show, "CompanionBubble.MessageType", "the line has a type of its own on the same wire");
        AssertPresent(show, "playerIDs: null", "every client renders her, so the line goes to all of them");
        AssertAbsent(show, "Game1.multiplayer", "the SMAPI multiplayer API is the seam now; the engine's protected field is not reached");

        AssertPresent(
            MethodBody(mod, "private void OnModMessageReceived("),
            "e.Type == CompanionBubble.MessageType",
            "an arriving line is dispatched by type on the same handler that already carries player control");
        AssertPresent(MethodBody(mod, "private void ShowReceivedCompanionBubble("), "CompanionBubble.IsValid(message", "a received line is re-validated before it is shown");

        // The draw is armed on EVERY declaration of the layer it belongs in, derived from the loaded assembly: the game
        // overrides drawAboveAlwaysFrontLayer per location type (Town, Woods, MineShaft...), so a base-only patch would
        // silently skip most of the maps she walks on.
        string install = MethodBody(mod, "private void InstallCompanionBubbles(");
        AssertPresent(install, "nameof(GameLocation.drawAboveAlwaysFrontLayer)", "the hook is the layer vanilla draws overhead text into");
        AssertPresent(install, "typeof(GameLocation).Assembly.GetTypes()", "the declarations are read from the assembly, not from a hand-written list");
        AssertPresent(install, "declaration.DeclaringType != locationType", "only the type that declares the override gets patched");
    }

    [Fact]
    public void TheDrawHookBindsOnlyHarmonyInjections()
    {
        string mod = StripLineComments(ReadModEntry());

        // Harmony binds a postfix's ordinary parameters by NAME to the target's, and refuses the whole patch when the name
        // is not one of them (measured on the shipped 0Harmony 2.2.2: Parameter "batch" not found in method
        // GameLocation::drawAboveAlwaysFrontLayer(SpriteBatch b)). A parameter other than an injection therefore arms
        // nothing at all - silently, since the installer would only log its warnings. The batch is read instead.
        AssertPresent(
            mod,
            "private static void DrawCompanionBubblesPostfix(GameLocation __instance, MethodBase __originalMethod)",
            "the draw hook may take only Harmony's injections, never a name-bound engine parameter");
        AssertPresent(
            MethodBody(mod, "private static void DrawCompanionBubblesPostfix("),
            "Game1.spriteBatch",
            "the batch is the object every caller passes into the layer the engine has already begun");
        AssertPresent(
            MethodBody(mod, "private void InstallCompanionBubbles("),
            "if (patched == 0)",
            "a hook that patched nothing has to say so, or it looks armed and draws nothing");
    }

    [Fact]
    public void TheBubbleDoesNotReplaceTheChatWrite()
    {
        string presentation = MethodBody(StripLineComments(ReadModEntry()), "private bool TrySendCompanionPresentation(");

        int bubble = presentation.IndexOf("this.TryShowCompanionBubble(", StringComparison.Ordinal);
        int chat = presentation.IndexOf("this.TrySendNativeChat(", StringComparison.Ordinal);

        bubble.Should().BeGreaterThanOrEqualTo(0, "the in-world bubble is what makes the line reach a player who is looking at the farmer");
        chat.Should().BeGreaterThanOrEqualTo(0, "the chat line is the log: it persists for scroll-back and reaches the whole lobby");
        bubble.Should().BeLessThan(chat, "the bubble is presentation and the chat write is the delivery the receipt attests; the bubble must not replace it");
        presentation.Should().Contain("return this.TrySendNativeChat(", "the chat write stays the method's return value, so a failed bubble cannot silently become the delivery outcome");
    }

    [Fact]
    public void TheBubbleCannotBeReachedThroughTheNpcOnlySeam()
    {
        // NEGATIVE, and the reason the presentation is drawn here at all: on the target version showTextAboveHead is
        // declared by NPC only. A `farmhand.showTextAboveHead(...)` would not compile, and a version of this code that
        // reached for it would be reaching for a method a Farmer does not have.
        StripLineComments(ReadModEntry()).Should().NotContain("showTextAboveHead");

        AssertLinesContain(Path.Combine(DecompiledRelativeRoot, "StardewValley", "NPC.cs"), new (int Line, string Fragment)[]
        {
            (1372, "public void showTextAboveHead(string text, Color? spriteTextColor = null, int style = 2, int duration = 3000, int preTimer = 0)"),
        });
        // ... and the bubble routine it uses instead is the engine's, with the pointer argument - and no alpha, which is
        // why the line holds at full opacity for its lifetime instead of fading.
        AssertLinesContain(Path.Combine(DecompiledRelativeRoot, "StardewValley.BellsAndWhistles", "SpriteText.cs"), new (int Line, string Fragment)[]
        {
            (448, "public static void drawSmallTextBubble(SpriteBatch b, string s, Vector2 positionOfBottomCenter, int maxWidth = -1, float layerDepth = -1f, bool drawPointerOnTop = false)"),
        });
    }

    // ---------------------------------------------------------------------------------------

    private static string ReadRepositoryFile(string relativePath) =>
        File.ReadAllText(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, RepositoryRelativeRoot, relativePath)));

    private static string ReadModEntry() => ReadRepositoryFile(Path.Combine("integrations", "stardew", "ModEntry.cs"));

    private static string ReadCompanionBubble() => ReadRepositoryFile(Path.Combine("integrations", "stardew", "CompanionBubble.cs"));

    /// <summary>
    /// Every Mod source file with its comments stripped, excluding the tests, the build outputs and the generated
    /// action-development tree: the population comes from the tree, so a new file is covered by existing.
    /// </summary>
    private static IEnumerable<(string Path, string Source)> ModSources()
    {
        string root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, RepositoryRelativeRoot, "integrations", "stardew"));
        foreach (string file in Directory.EnumerateFiles(root, "*.cs", SearchOption.AllDirectories))
        {
            string relative = Path.GetRelativePath(root, file).Replace('\\', '/');
            if (relative.StartsWith("tests/", StringComparison.Ordinal)
                || relative.StartsWith("bin/", StringComparison.Ordinal)
                || relative.StartsWith("obj/", StringComparison.Ordinal)
                || relative.Contains("/bin/", StringComparison.Ordinal)
                || relative.Contains("/obj/", StringComparison.Ordinal)
                || relative.StartsWith("action-development/", StringComparison.Ordinal))
            {
                continue;
            }
            yield return (relative, StripLineComments(File.ReadAllText(file)));
        }
    }

    /// <summary>
    /// The integer one decompiled line assigns, read from the engine's own source: no second hand-written copy of a
    /// fact this gate compares against.
    /// </summary>
    private static int EngineInt(string relativePath, int line, string prefix, string suffix)
    {
        string path = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, RepositoryRelativeRoot, DecompiledRelativeRoot, relativePath));
        File.Exists(path).Should().BeTrue($"the decompiled reference must exist at {relativePath}; re-derive the engine seam against the target version");
        string text = File.ReadAllLines(path)[line - 1];

        int at = text.IndexOf(prefix, StringComparison.Ordinal);
        Assert.True(at >= 0, $"decompiled {Path.GetFileName(relativePath)}:{line} no longer contains '{prefix}' -- the target version drifted; re-derive the engine seam before accepting this presentation path.");
        int start = at + prefix.Length;
        int end = text.IndexOf(suffix, start, StringComparison.Ordinal);
        Assert.True(end > start, $"decompiled {Path.GetFileName(relativePath)}:{line} does not end '{prefix}' with '{suffix}'");
        // The engine writes a float where it draws (4f); the number is the same one.
        return int.Parse(text[start..end].TrimEnd('f'), CultureInfo.InvariantCulture);
    }

    private static void AssertLinesContain(string relative, IReadOnlyList<(int Line, string Fragment)> expected)
    {
        string path = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, RepositoryRelativeRoot, relative));
        File.Exists(path).Should().BeTrue($"the decompiled reference must exist at {relative}; re-derive the engine seam against the target version before accepting this presentation path");
        string[] lines = File.ReadAllLines(path);

        foreach ((int line, string fragment) in expected)
        {
            int index = line - 1;
            if (index >= lines.Length || !lines[index].Contains(fragment, StringComparison.Ordinal))
                Assert.Fail($"decompiled {Path.GetFileName(relative)}:{line} no longer contains '{fragment}' -- the target version drifted; re-derive the engine seam before accepting this presentation path.");
        }
    }

    private static void AssertPresent(string source, string fragment, string why)
    {
        if (source.Contains(fragment, StringComparison.Ordinal))
            return;
        Assert.Fail($"'{fragment}' is not in the source: {why}");
    }

    /// <summary>Names the token and the line it is still on - the failure has to say what to delete.</summary>
    private static void AssertAbsent(string source, string token, string why)
    {
        int at = source.IndexOf(token, StringComparison.Ordinal);
        if (at < 0)
            return;
        int line = 1;
        for (int index = 0; index < at; index++)
        {
            if (source[index] == '\n')
                line++;
        }
        Assert.Fail($"'{token}' is still in the source at line {line}: {why}");
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
