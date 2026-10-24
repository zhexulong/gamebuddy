using System.Collections.Generic;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// The engine does not swing at the tile you name. `Character.GetToolLocation` derives the swing point
/// from WHERE THE ACTOR STANDS and WHICH WAY IT FACES, not from the target:
///
///   facing 0 (up)    -> (bbox.X + w/2, bbox.Y - 64)
///   facing 1 (right) -> (bbox.X + w + 64, bbox.Y + h/2)
///   facing 2 (down)  -> (bbox.X + w/2, bbox.Y + h + 64)
///   facing 3 (left)  -> (bbox.X - 64, bbox.Y + h/2)
///
/// This Mod calls `tool.DoFunction(location, tileX*64+32, tileY*64+32, 1, who)` instead, naming the
/// target directly. That is strictly more reliable than the engine - it cannot miss - and it is exactly
/// why it is worth stating out loud: the action hits whether or not the actor is facing the target, so
/// the picture (where the actor looks) and the effect (which tile changed) are allowed to disagree.
///
/// These cases pin the geometry, so the agreement between facing and effect becomes a decision rather
/// than an accident.
/// </summary>
public sealed class ToolSwingPointTests
{
    // A 16x32 actor whose tile is (x,y): the engine's bounding box for a standing farmer.
    // From Character.GetBoundingBox: `(Position.X + 8, Position.Y + 16, width, 32)`.
    private const int BoxWidth = 16;
    private const int BoxHeight = 32;

    /// <summary>
    /// The engine's swing point for an actor standing on <paramref name="tileX"/>,<paramref name="tileY"/>
    /// and facing <paramref name="facing"/>.
    ///
    /// `Character.GetToolLocation` takes the bounding box and offsets by one 64px tile in the facing
    /// direction. The box is inset from `Position` by (8, 16), and a farmer standing on a tile has
    /// `Position = (tileX*64, tileY*64 - 32)` because the sprite hangs above the tile it occupies.
    /// </summary>
    private static (int X, int Y) EngineSwingPoint(int tileX, int tileY, int facing)
    {
        int boxX = tileX * 64 + 8;
        int boxY = tileY * 64 - 32 + 16;
        return facing switch
        {
            0 => (boxX + BoxWidth / 2, boxY - 64),
            1 => (boxX + BoxWidth + 64, boxY + BoxHeight / 2),
            2 => (boxX + BoxWidth / 2, boxY + BoxHeight + 64),
            3 => (boxX - 64, boxY + BoxHeight / 2),
            _ => (boxX, boxY),
        };
    }

    private static (int X, int Y) OurSwingPoint(int tileX, int tileY) => (tileX * 64 + 32, tileY * 64 + 32);

    [Fact]
    public void FacingTheTargetIsTheOnlyCaseWhereTheTwoAgree()
    {
        // Actor on (10,10), target on (11,10) - to its right. Only facing 1 puts the engine's swing
        // point on the target's tile; every other facing swings somewhere else entirely.
        var agreements = new List<int>();
        for (int facing = 0; facing < 4; facing += 1)
        {
            (int X, int Y) engine = EngineSwingPoint(10, 10, facing);
            (int X, int Y) ours = OurSwingPoint(11, 10);
            bool sameTile = engine.X / 64 == ours.X / 64 && engine.Y / 64 == ours.Y / 64;
            if (sameTile) agreements.Add(facing);
        }

        agreements.Should().Equal(new[] { 1 }, "only facing the target makes the engine hit it");
    }

    [Fact]
    public void OurSwingPointLandsOnTheTargetRegardlessOfFacing()
    {
        // This is the property the Mod relies on: no facing requirement. Recording it as a test rather
        // than a comment means a future change that reintroduces the engine's geometry fails here and
        // has to say what it chose.
        for (int facing = 0; facing < 4; facing += 1)
        {
            (int X, int Y) ours = OurSwingPoint(11, 10);
            (ours.X / 64).Should().Be(11);
            (ours.Y / 64).Should().Be(10);
        }
    }

    [Fact]
    public void TheEngineSwingPointIsOneTileAwayInTheFacingDirection()
    {
        // Stated as geometry, because it is the fact that makes presentation and effect disagree:
        // the animation shows the actor swinging where it faces, and the effect lands on the target.
        // boxX = tile*64+8, boxY = tile*64-16.
        EngineSwingPoint(10, 10, 0).Should().Be((10 * 64 + 8 + 8, (10 * 64 - 16) - 64));
        EngineSwingPoint(10, 10, 1).Should().Be((10 * 64 + 8 + 16 + 64, (10 * 64 - 16) + 16));
        EngineSwingPoint(10, 10, 2).Should().Be((10 * 64 + 8 + 8, (10 * 64 - 16) + 32 + 64));
        EngineSwingPoint(10, 10, 3).Should().Be((10 * 64 + 8 - 64, (10 * 64 - 16) + 16));
    }
}
