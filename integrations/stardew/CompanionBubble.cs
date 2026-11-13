using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Graphics;
using StardewValley;
using StardewValley.Menus;

namespace GameBuddy.Stardew;

/// <summary>
/// One companion line as the WORLD shows it: the engine's own speech bubble - rounded box, corners and pointer - over
/// her head, drawn by whichever client is rendering her.
///
/// <para>
/// WHY IT IS NOT A SPRITE ANY MORE. The previous shape broadcast two <c>TemporaryAnimatedSprite</c>s: the glyphs, and a
/// panel assembled here out of the bubble's CENTRE tile stretched to the text's size. The glyph half arrived intact; the
/// panel half could not, because a sprite's panel is a rectangle with no corners, no edges and no tail - a right-angled
/// box where the game draws a rounded bubble with a pointer. The engine's own 9-slice box is public on the target
/// version (<c>SpriteText.cs:456</c>, the same one <c>PetBowl.cs:137</c>, <c>Object.cs:5494</c> and
/// <c>DayTimeMoneyBox.cs:539</c> call), so the panel is not something to reconstruct: it is something to stop
/// reconstructing - and its geometry is copied from that one call rather than invented here.
/// </para>
/// <para>
/// WHY THE FONT IS NOT THE ENGINE'S. <c>drawSmallTextBubble</c> is <c>Game1.smallFont</c> end to end: it parses at
/// <c>:452</c>, measures at <c>:455</c> and draws at <c>:465</c> - the face the game uses for pet names and gold
/// strings, which is why a spoken line came out too small to read. A player reads an NPC's line in
/// <c>Game1.dialogueFont</c>, so this unit keeps the engine's box and pointer and draws the glyphs in the dialogue face.
/// The panel is sized from the SAME font that fills it: a box measured with one face and filled with another is text
/// hanging out of the box.
/// </para>
/// <para>
/// WHAT CROSSES THE WIRE INSTEAD. A line is now a small ModMessage: the speaker's player id and the text. Each client
/// keeps the live lines for its own screen and draws them in the engine's above-always-front layer, from the speaker's
/// own standing pixel - so the bubble is re-anchored where she is, exactly as the engine anchors a vanilla NPC's
/// overhead text. A drawn sprite could not do that: <c>TemporaryAnimatedSprite.draw</c> renders a text sprite at the
/// position it was created with and never reads <c>attachedCharacter</c> (<c>:1586</c>), which is why the old shape
/// needed a per-frame pass over the location's sprite list to move it.
/// </para>
/// <para>
/// WHAT THE ENGINE DOES NOT DO. The bubble takes no alpha: it paints the box and the glyph run at full opacity, as every
/// vanilla caller does. The line therefore holds for its whole lifetime and ends, instead of fading; a fade would have
/// to be drawn here, and drawing the panel here is the defect this replaces.
/// </para>
/// </summary>
internal static class CompanionBubble
{
    /// <summary>The ModMessage type carrying one line to the other clients.</summary>
    internal const string MessageType = "gamebuddy.companion_bubble.v1";

    /// <summary>
    /// The line's whole life: <c>NPC.showTextAboveHead</c>'s own duration default (<c>NPC.cs:1372</c>), so a companion
    /// line is on screen exactly as long as a villager's.
    /// </summary>
    internal const int DurationMs = 3000;

    /// <summary>
    /// The width one line of dialogue may occupy before it wraps, in dialogue-font pixels. 448 is ~17 CJK glyphs at the
    /// 25 px the dialogue face measures per glyph: wide enough that a spoken sentence reads as one or two lines, and a
    /// third of a 1280-wide viewport so the box never spans the scene. The engine's own inset (16 px, the padding its
    /// 9-slice adds around the run) is taken off before wrapping, exactly as <c>drawSmallTextBubble</c> does at
    /// <c>:452</c>.
    /// </summary>
    internal const int MaxWidth = 448;

    /// <summary>
    /// What a line says when it is cut: the characters kept are the wrapped run's own, and the chat write has already
    /// carried the whole sentence, so nothing is lost - only the world surface stops growing.
    /// </summary>
    internal const string Ellipsis = "…";

    /// <summary>
    /// The wire bound on a line. A bubble is a sentence, not a transcript: the line arrives already trimmed to the one
    /// the Host presented, and this refuses a frame that could not be a line at all.
    /// </summary>
    internal const int MaxTextLength = 4_000;

    /// <summary>
    /// How many dialogue lines fit in the height the bubble hangs in. The box grows UPWARD from <see cref="BottomCenter"/>,
    /// so its height is the height above her head it may occupy: the engine lifts overhead text by
    /// <c>Sprite.SpriteHeight * 4</c> (<c>NPC.cs:5209</c>), which for a Farmer's 32-px frame (<c>FarmerSprite.cs:564</c>)
    /// is 128 px - two dialogue lines of 42 px plus the box's 12 px of padding, and not three (138 px).
    /// </summary>
    internal static int LinesThatFit(int lineSpacing, int spriteHeight) =>
        Math.Max(1, (spriteHeight * SpriteScale - BubbleLayout.BoxPaddingY) / lineSpacing);

    /// <summary>
    /// The engine's pointer (<c>drawSmallTextBubble</c> draws its 5x5 tile at scale 4 starting 4 px below the anchor)
    /// hangs this far below the bottom-centre it is given, so the anchor sits one pointer above the head's top edge and
    /// the tail's tip lands on her head instead of inside it.
    /// </summary>
    private const int PointerHeight = 24;

    /// <summary>The engine's own pixel scale for this bubble: every piece of it is drawn at 4x.</summary>
    internal const int SpriteScale = 4;

    /// <summary>The layer the line's box is drawn at inside the above-always-front batch, as the small bubble was.</summary>
    private const float LayerDepth = 1f;

    /// <summary>The engine's own ordering: the tail sits one step above the box, the glyphs one step above the tail.</summary>
    private const float PointerLayerOffset = 1E-05f;

    private const float TextLayerOffset = 2E-05f;

    /// <summary>
    /// The bottom-centre the bubble hangs from: over her head, which is one sprite height times four above the
    /// standing pixel (the engine's own overhead-text geometry, <c>NPC.cs:5209</c>).
    /// </summary>
    internal static Vector2 BottomCenter(Point standingPixel, int spriteHeight) =>
        new(standingPixel.X, standingPixel.Y - spriteHeight * SpriteScale - PointerHeight);

    /// <summary>Whether an incoming line is one this client may show.</summary>
    internal static bool IsValid(CompanionBubbleMessage? message, out string reasonCode)
    {
        if (message is null
            || message.SpeakerPlayerId <= 0
            || string.IsNullOrWhiteSpace(message.Text)
            || message.Text.Length > MaxTextLength)
        {
            reasonCode = "companion_bubble_invalid";
            return false;
        }
        reasonCode = "accepted";
        return true;
    }

    /// <summary>
    /// The lines a bubble can actually show: the engine wraps the text, and anything past the height budget is cut with
    /// <see cref="Ellipsis"/> rather than allowed to grow a box taller than the space she stands in.
    /// </summary>
    internal static string ClampToLines(string wrapped, int maxLines)
    {
        string[] lines = wrapped.Replace("\r\n", "\n").Split('\n');
        if (lines.Length <= maxLines)
            return wrapped.Trim();
        return string.Join(Environment.NewLine, lines, 0, maxLines).TrimEnd() + Ellipsis;
    }

    /// <summary>
    /// Draws one line in the engine's own bubble box, in the dialogue face. <paramref name="bottomCenter"/> is a SCREEN
    /// position: the caller converts the speaker's world pixel with <c>Game1.GlobalToLocal</c>, which is what the batch
    /// the engine has already begun for the above-always-front layer expects. <paramref name="spriteHeight"/> is the
    /// speaker's own frame height, which bounds how tall the box may become.
    /// </summary>
    internal static void Draw(SpriteBatch batch, string text, Vector2 bottomCenter, int spriteHeight)
    {
        string wrapped = Game1.parseText(text, Game1.dialogueFont, MaxWidth - BubbleLayout.BoxPaddingX);
        string line = ClampToLines(
            wrapped,
            LinesThatFit(Game1.dialogueFont.LineSpacing, spriteHeight));
        BubbleLayout layout = BubbleLayout.For(bottomCenter, Game1.dialogueFont.MeasureString(line));

        IClickableMenu.drawTextureBox(
            batch,
            Game1.mouseCursors_1_6,
            new Rectangle(241, 503, 9, 9),
            layout.Box.X,
            layout.Box.Y,
            layout.Box.Width,
            layout.Box.Height,
            Color.White,
            SpriteScale,
            drawShadow: false,
            LayerDepth);
        batch.Draw(
            Game1.mouseCursors_1_6,
            layout.Pointer,
            new Rectangle(251, 506, 5, 5),
            Color.White,
            0f,
            Vector2.Zero,
            SpriteScale,
            SpriteEffects.None,
            LayerDepth + PointerLayerOffset);
        Utility.drawTextWithShadow(batch, line, Game1.dialogueFont, layout.Text, Game1.textColor, 1f, LayerDepth + TextLayerOffset, shadowIntensity: 0.5f);
    }
}

/// <summary>
/// The three pieces of one bubble over one anchor, in the engine's own geometry - copied from
/// <c>SpriteText.drawSmallTextBubble</c> line for line (<c>:456</c> the box, <c>:465</c> the run, <c>:463</c> the tail),
/// so any departure from the engine can be checked against those lines instead of argued about. The run is measured
/// elsewhere and handed in, which is what keeps the box the size of the text it holds.
/// </summary>
internal readonly record struct BubbleLayout(Rectangle Box, Vector2 Text, Vector2 Pointer)
{
    /// <summary>The padding the engine's 9-slice adds around the measured run: 16 wide, 12 tall.</summary>
    internal const int BoxPaddingX = 16;

    internal const int BoxPaddingY = 12;

    internal static BubbleLayout For(Vector2 bottomCenter, Vector2 measured) =>
        new(
            new Rectangle(
                (int)(bottomCenter.X - measured.X / 2f - 4f),
                (int)(bottomCenter.Y - measured.Y),
                (int)measured.X + BoxPaddingX,
                (int)measured.Y + BoxPaddingY),
            bottomCenter - measured + new Vector2(4f + measured.X / 2f, 8f),
            bottomCenter + new Vector2(-2.5f, 1f) * 4f);
}

/// <summary>One companion line on the wire: whose head it belongs over, and what it says.</summary>
internal sealed record CompanionBubbleMessage(long SpeakerPlayerId, string Text);

/// <summary>One line as this client is showing it: the text, and the game-time millisecond it is over at.</summary>
internal readonly record struct CompanionBubbleLine(long SpeakerPlayerId, string Text, long ExpiresAtMs);

/// <summary>
/// The lines THIS client is showing, one per speaker.
///
/// <para>
/// The lifetime is kept here rather than in a sprite or a coroutine because a line must end at a moment, not on a loop
/// count: the previous shape inherited the sprite's tick counter and a fade that shared it. A board entry is replaced
/// by the next line the same speaker says, so two lines never stack over one head, and it is dropped the moment its
/// lifetime is over - including while the world is being drawn, so nothing outlives its duration or the scene it was
/// said in.
/// </para>
/// </summary>
internal sealed class CompanionBubbleBoard
{
    private readonly Dictionary<long, CompanionBubbleLine> lines = new();

    /// <summary>The number of live lines. One per speaker at most.</summary>
    internal int Count => this.lines.Count;

    /// <summary>The live lines, in no particular order.</summary>
    internal IReadOnlyCollection<CompanionBubbleLine> Lines => this.lines.Values;

    /// <summary>
    /// Shows one line from now until <see cref="CompanionBubble.DurationMs"/> later, replacing whatever the same
    /// speaker was saying. <paramref name="nowMs"/> is game time, so a paused game does not age the line.
    /// </summary>
    internal void Show(long speakerPlayerId, string text, long nowMs) =>
        this.lines[speakerPlayerId] = new CompanionBubbleLine(speakerPlayerId, text, nowMs + CompanionBubble.DurationMs);

    /// <summary>
    /// Drops every line whose lifetime has been reached. The comparison is inclusive because
    /// <c>ExpiresAtMs</c> IS the first millisecond the line is over, so a line at exactly its expiry is not shown.
    /// </summary>
    internal void Expire(long nowMs)
    {
        // The draw calls this every frame, and almost every frame has nothing to look at.
        if (this.lines.Count == 0)
            return;
        List<long>? expired = null;
        foreach ((long speakerPlayerId, CompanionBubbleLine line) in this.lines)
        {
            if (line.ExpiresAtMs <= nowMs)
                (expired ??= new List<long>()).Add(speakerPlayerId);
        }
        if (expired is null)
            return;
        foreach (long speakerPlayerId in expired)
            this.lines.Remove(speakerPlayerId);
    }
}
