using System;

namespace GameBuddy.Stardew.Core;

/// <summary>
/// The facing that makes the engine's own swing geometry land on a target.
///
/// `Character.GetToolLocation` does not take a tile: it takes the actor's bounding box and steps one
/// 64px tile in `FacingDirection`. So "swing at this tile" is only reachable when the actor stands on a
/// cardinal neighbour of it and faces toward it - the engine's four cases are up, right, down, left, and
/// its offset is one tile, not a ray.
///
/// The Mod has been naming the target tile directly (`DoFunction(location, tile*64+32, ...)`), which
/// always hits and therefore lets two things drift apart: the animation shows a swing where the actor
/// faces, and the effect lands on the target. Calling this before the swing is what makes those agree -
/// and answering null is the honest outcome for a diagonal or out-of-reach target, because forcing a
/// facing there would produce a swing that visibly misses.
/// </summary>
public static class SwingFacing
{
    public const int Up = 0;
    public const int Right = 1;
    public const int Down = 2;
    public const int Left = 3;

    /// <summary>
    /// The engine facing that puts the swing on <paramref name="target"/>, or null when the actor is not
    /// on a cardinal neighbour of it.
    /// </summary>
    public static int? For((int X, int Y) actor, (int X, int Y) target)
    {
        int dx = target.X - actor.X;
        int dy = target.Y - actor.Y;

        // Cardinal and exactly one tile: anything else is not a swing the engine can land.
        if (dx == 0 && dy == -1) return Up;
        if (dx == 1 && dy == 0) return Right;
        if (dx == 0 && dy == 1) return Down;
        if (dx == -1 && dy == 0) return Left;
        return null;
    }
}
