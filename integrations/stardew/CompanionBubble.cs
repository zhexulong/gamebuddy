using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.BellsAndWhistles;

namespace GameBuddy.Stardew;

/// <summary>
/// One companion line as the WORLD shows it: text over her head, on a panel, anchored to her as she walks, fading out
/// instead of vanishing. The chat write stays the delivery the receipt attests; this is presentation beside it.
///
/// <para>
/// WHAT WAS WRONG. The line was a bare text sprite: no panel, so white glyphs disappeared on snow and in the dark; the
/// engine's text branch draws at the coordinates the sprite was CREATED at and never reads <c>attachedCharacter</c>
/// (<c>TemporaryAnimatedSprite.draw:1586</c>), so the text hung in the air where she had stood; and the sprite ended
/// on its loop count with no alpha decay, so the line was cut rather than faded.
/// </para>
/// <para>
/// WHY IT IS BUILT THIS WAY. The bubble is broadcast (<c>Multiplayer.broadcastSprites</c>) because the player who
/// watches the companion is the human on the HOST client - the AI client only owns her body - so the sprite has to be
/// something the ENGINE can render and reload on the far side. That rules out drawing it here (it would never reach
/// the host) and rules out a runtime texture for the panel (the wire carries a content asset NAME; the receiver loads
/// it, <c>TemporaryAnimatedSprite.cs:830</c>). What the engine cannot do for a text sprite, this class does per frame
/// on every client: re-anchor to the speaker's live standing pixel, and set alpha from the sprite's own elapsed ticks.
/// </para>
/// <para>
/// COST. Per frame, per live bubble: one <c>StandingPixel</c> read (cached by the engine against her position) and one
/// width measure. Nothing is allocated, nothing is tracked outside the sprite itself, and there is no setting: the
/// duration, the fade and the panel are one shape for every line.
/// </para>
/// </summary>
internal static class CompanionBubble
{
    /// <summary>
    /// The line's whole life: <c>NPC.showTextAboveHead</c>'s own duration default. <see cref="Ticks"/> is the same
    /// duration in the unit the sprite counts down in (60 updates a second), so the pair is one fact in two units and
    /// the sprite's interval (one tick) times its loop count is exactly this long.
    /// </summary>
    internal const int DurationMs = 3000;

    /// <summary>See <see cref="DurationMs"/>.</summary>
    internal const int Ticks = 30;

    /// <summary>
    /// The last 8 ticks (800 ms) are the fade. A vanilla NPC bubble holds at full opacity and fades over its last
    /// stretch; the point is that the line never disappears between one frame and the next.
    /// </summary>
    internal const int FadeTicks = 8;

    /// <summary>Space between the glyphs and the panel's edge, in pixels.</summary>
    internal const int Padding = 8;

    /// <summary>
    /// The engine's own marker for "draw this sprite's text as world text" (<c>TemporaryAnimatedSprite.draw:1584</c>).
    /// It cannot be anything else: this exact value is what routes the sprite to <c>SpriteText.drawString</c>.
    /// </summary>
    internal const int TextMarker = -777;

    /// <summary>The panel's marker in the same field, so one pass over the sprite list can tell the two halves apart.</summary>
    internal const int PanelMarker = -778;

    /// <summary>
    /// The loose-sprites sheet the vanilla small speech bubble's box is cut from (<c>SpriteText.drawSmallTextBubble</c>
    /// uses <c>Game1.mouseCursors_1_6</c>, loaded from this asset at <c>Game1.cs:2385</c>). The NAME, not the texture:
    /// a broadcast sprite crosses the wire as a content asset name and the receiving client reloads it.
    /// </summary>
    internal const string PanelTextureName = "LooseSprites\\Cursors_1_6";

    /// <summary>
    /// The panel's fill: the CENTRE tile of the vanilla small-bubble box. That box is
    /// <c>Rectangle(241, 503, 9, 9)</c> drawn through <c>IClickableMenu.drawTextureBox</c>, whose 9-slice fills the
    /// interior with the centre third (<c>sourceRect.X + sourceRect.Width / 3</c>, size <c>Width / 3</c>), so
    /// (244, 506, 3, 3) is by construction the bubble's own interior colour rather than a guessed pixel.
    /// </summary>
    private static readonly Rectangle PanelSourceRect = new(244, 506, 3, 3);

    /// <summary>
    /// The line's alpha at a point in its life: opaque while it is being read, then linearly to zero over the last
    /// <see cref="FadeTicks"/>. A function of elapsed ticks, never a boolean "alive".
    /// </summary>
    internal static float Alpha(int ticksElapsed)
    {
        int holdTicks = Ticks - FadeTicks;
        if (ticksElapsed <= holdTicks)
            return 1f;
        if (ticksElapsed >= Ticks)
            return 0f;
        return 1f - (ticksElapsed - holdTicks) / (float)FadeTicks;
    }

    /// <summary>
    /// The line the bubble hangs from: vanilla's own overhead-text placement
    /// (<c>NPC.drawAboveAlwaysFrontLayer</c>), one sprite height times four plus 64 px above the standing pixel, which
    /// is the centre of her bounding box.
    /// </summary>
    internal static float BaselineY(Point standingPixel, int spriteHeight) =>
        standingPixel.Y - spriteHeight * 4 - 64;

    /// <summary>Top-left of the glyph run, centred on the standing pixel.</summary>
    internal static Vector2 TextTopLeft(Point standingPixel, int spriteHeight, int textWidth) =>
        new(standingPixel.X - textWidth / 2f, BaselineY(standingPixel, spriteHeight));

    /// <summary>The panel behind the glyph run: the same anchor, one <see cref="Padding"/> of backing all round.</summary>
    internal static Rectangle PanelRect(Point standingPixel, int spriteHeight, int textWidth, int textHeight) =>
        new(
            (int)TextTopLeft(standingPixel, spriteHeight, textWidth).X - Padding,
            (int)BaselineY(standingPixel, spriteHeight) - Padding,
            textWidth + Padding * 2,
            textHeight + Padding * 2);

    /// <summary>Whether this sprite is one of ours, so the per-frame pass leaves every other sprite in the world alone.</summary>
    internal static bool IsCompanionBubble(TemporaryAnimatedSprite sprite) =>
        // Every bubble names its speaker, and the engine transmits a Farmer attachment as her player id, so this is
        // also the identity the far side resolves her from. Vanilla text sprites never carry one.
        sprite.attachedCharacter is not null
        && sprite.extraInfoForEndBehavior is TextMarker or PanelMarker;

    /// <summary>The glyph half of one line.</summary>
    internal static TemporaryAnimatedSprite TextSprite(Character speaker, string text, int textWidth)
    {
        TemporaryAnimatedSprite sprite = new(
            0,
            DurationMs / (float)Ticks,
            1,
            Ticks,
            TextTopLeft(speaker.StandingPixel, speaker.Sprite.SpriteHeight, textWidth),
            flicker: false,
            flipped: false)
        {
            text = text,
            extraInfoForEndBehavior = TextMarker,
            attachedCharacter = speaker,
            // The glyph colour is the engine's own binary choice (`TemporaryAnimatedSprite.draw:1587` paints WHITE for a
            // white sprite colour and BLACK for anything else). Black, because the line now sits on a pale panel - and
            // white glyphs on snow were half the reason the panel exists.
            color = Color.Black,
            drawAboveAlwaysFront = true,
            layerDepth = 1f,
        };
        return sprite;
    }

    /// <summary>The panel half of one line, drawn by the engine from the vanilla bubble's own sheet.</summary>
    internal static TemporaryAnimatedSprite PanelSprite(Character speaker, int textWidth, int textHeight)
    {
        Rectangle panel = PanelRect(speaker.StandingPixel, speaker.Sprite.SpriteHeight, textWidth, textHeight);
        TemporaryAnimatedSprite sprite = new(
            0,
            DurationMs / (float)Ticks,
            1,
            Ticks,
            new Vector2(panel.X, panel.Y),
            flicker: false,
            flipped: false)
        {
            // Both the texture and its asset name: this process draws from the texture, the receiving client reloads it
            // from the name. The panel's size rides in vectorScale, which is the engine's only non-uniform stretch for a
            // broadcast sprite, so the follow pass can re-derive its width without a second field of our own.
            texture = Game1.mouseCursors_1_6,
            textureName = PanelTextureName,
            sourceRect = PanelSourceRect,
            vectorScale = new Vector2(
                panel.Width / (float)PanelSourceRect.Width,
                panel.Height / (float)PanelSourceRect.Height),
            extraInfoForEndBehavior = PanelMarker,
            attachedCharacter = speaker,
            drawAboveAlwaysFront = true,
            layerDepth = 1f,
        };
        return sprite;
    }

    /// <summary>
    /// Re-derives one live bubble sprite from its speaker: where she is NOW, and how far into its life the line is.
    ///
    /// This is the whole reason the bubble is not simply left to the engine. A text sprite is drawn at
    /// <c>Game1.GlobalToLocal(position)</c> (draw:1586) and the text branch never consults <c>attachedCharacter</c>, so
    /// without this the line stays where she stood; the engine's own alpha decay is per tick and shares its clock with
    /// the loop count, so reading the tick count here keeps one clock for both halves of the bubble.
    /// </summary>
    internal static void Follow(TemporaryAnimatedSprite sprite, Character speaker)
    {
        Point standing = speaker.StandingPixel;
        int spriteHeight = speaker.Sprite.SpriteHeight;
        if (sprite.text is { } text)
        {
            sprite.position = TextTopLeft(standing, spriteHeight, SpriteText.getWidthOfString(text));
        }
        else
        {
            float width = sprite.vectorScale.X * PanelSourceRect.Width;
            sprite.position = new Vector2(standing.X - width / 2f, BaselineY(standing, spriteHeight) - Padding);
        }

        sprite.alpha = Alpha(sprite.currentNumberOfLoops);
    }
}
