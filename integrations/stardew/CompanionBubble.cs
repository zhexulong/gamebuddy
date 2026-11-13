using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Graphics;
using StardewValley.BellsAndWhistles;

namespace GameBuddy.Stardew;

/// <summary>
/// One companion line as the WORLD shows it: the engine's own small speech bubble - rounded box, corners and pointer -
/// over her head, drawn by whichever client is rendering her.
///
/// <para>
/// WHY IT IS NOT A SPRITE ANY MORE. The previous shape broadcast two <c>TemporaryAnimatedSprite</c>s: the glyphs, and a
/// panel assembled here out of the bubble's CENTRE tile stretched to the text's size. The glyph half arrived intact; the
/// panel half could not, because a sprite's panel is a rectangle with no corners, no edges and no tail - a right-angled
/// box where the game draws a rounded bubble with a pointer. The engine's own routine draws the whole thing and is
/// public on the target version (<c>SpriteText.cs:448</c>, the same one <c>PetBowl.cs:137</c>,
/// <c>Object.cs:5494</c> and <c>DayTimeMoneyBox.cs:539</c> call), so the panel is not something to reconstruct: it is
/// something to stop reconstructing.
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
/// WHAT THE ENGINE DOES NOT DO. <c>drawSmallTextBubble</c> takes no alpha: it paints the box and the glyph run at full
/// opacity, as every vanilla caller does. The line therefore holds for its whole lifetime and ends, instead of fading;
/// a fade would have to be drawn here, and drawing the panel here is the defect this replaces.
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
    /// The width the engine wraps a line at before measuring it (<c>drawSmallTextBubble</c> calls
    /// <c>Game1.parseText(s, Game1.smallFont, maxWidth - 16)</c>), in the same 4x pixel units the small font measures
    /// in. 256 is the width the game already wraps world text at (<c>Object.cs:5494</c>).
    /// </summary>
    internal const int MaxWidth = 256;

    /// <summary>
    /// The wire bound on a line. A bubble is a sentence, not a transcript: the line arrives already trimmed to the one
    /// the Host presented, and this refuses a frame that could not be a line at all.
    /// </summary>
    internal const int MaxTextLength = 4_000;

    /// <summary>
    /// The engine's pointer (<c>drawSmallTextBubble</c> draws its 5x5 tile at scale 4 starting 4 px below the anchor)
    /// hangs this far below the bottom-centre it is given, so the anchor sits one pointer above the head's top edge and
    /// the tail's tip lands on her head instead of inside it.
    /// </summary>
    private const int PointerHeight = 24;

    /// <summary>
    /// The bottom-centre the engine's bubble hangs from: over her head, which is one sprite height times four above the
    /// standing pixel (the engine's own overhead-text geometry, <c>NPC.drawAboveAlwaysFrontLayer</c>).
    /// </summary>
    internal static Vector2 BottomCenter(Point standingPixel, int spriteHeight) =>
        new(standingPixel.X, standingPixel.Y - spriteHeight * 4 - PointerHeight);

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
    /// Draws one line with the engine's own bubble routine. <paramref name="bottomCenter"/> is a SCREEN position: the
    /// caller converts the speaker's world pixel with <c>Game1.GlobalToLocal</c>, which is what the batch the engine has
    /// already begun for the above-always-front layer expects.
    ///
    /// <para>
    /// <c>drawPointerOnTop: false</c> is the downward tail: the box hangs above the point it is given and the pointer
    /// reaches down to it. The alternative (<c>true</c>) flips the tail upward, for a box hanging BELOW its anchor - the
    /// gold-counter bubble (<c>DayTimeMoneyBox.cs:539</c>) - which is not this shape.
    /// </para>
    /// </summary>
    internal static void Draw(SpriteBatch batch, string text, Vector2 bottomCenter) =>
        SpriteText.drawSmallTextBubble(
            batch,
            text,
            bottomCenter,
            maxWidth: MaxWidth,
            layerDepth: 1f,
            drawPointerOnTop: false);
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
