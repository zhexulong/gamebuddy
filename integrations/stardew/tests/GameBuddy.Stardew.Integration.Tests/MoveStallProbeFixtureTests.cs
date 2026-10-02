using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Source pins for the move-stall probe fixture (design 5.3 observation).
/// The probe drives the PUBLISHED move_to_tile action over a fixture that
/// stands a native blocker on the route, measuring whether the native
/// pushing/pass-through mechanisms resolve the block before the native
/// 5000ms path cancel. The C# side of the probe is fixture-only: it adds no
/// action, no capability and no reason code, so these pins protect the
/// fixture's three hard-won geometry facts rather than a contract.
///
/// Each fact below was learned from a failed live run:
///   1. the warp must target the FARM (not the player's current location),
///      or OnWarped never fires because the warp goes to the wrong map;
///   2. the occupancy check must EXCLUDE the just-warped actor's own
///      Farmers class, or the anchor line always fails self-occupancy;
///   3. the line must be verified with the actual native planner (findPath
///      crossing the blocker tile), not a cheap passability scan -- the
///      planner's collisions include things isTilePassable misses.
/// </summary>
public class MoveStallProbeFixtureTests
{
    private static string RepositorySourcePath(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (File.Exists(candidate))
                    return candidate;
                directory = directory.Parent;
            }
        }
        throw new FileNotFoundException($"repository source not found: {relative}");
    }

    private static string ModEntrySource()
    {
        return File.ReadAllText(RepositorySourcePath(Path.Combine("integrations", "stardew", "ModEntry.cs")));
    }

    /// <summary>
    /// Extract one method body by brace balance from the source text. Only valid
    /// for bodies whose string literals contain no unbalanced braces.
    /// </summary>
    private static string MethodBody(string source, string declaration)
    {
        int start = source.IndexOf(declaration, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, $"declaration not found: {declaration}");
        int open = source.IndexOf('{', start);
        open.Should().BeGreaterThanOrEqualTo(0);
        int depth = 0;
        for (int i = open; i < source.Length; i++)
        {
            if (source[i] == '{')
                depth++;
            else if (source[i] == '}')
            {
                depth--;
                if (depth == 0)
                    return source.Substring(start, i - start + 1);
            }
        }
        throw new InvalidOperationException($"unbalanced body: {declaration}");
    }

    /// <summary>
    /// Extract the probe branch inside OnWarped between its two stable neighbour
    /// swallows. OnWarped's own body contains interpolated strings with braces,
    /// so brace-balance extraction is unreliable there; pinning the branch
    /// between the probe's `if` and the next known pending branch is stable.
    /// </summary>
    private static string ProbeOnWarpedBranch()
    {
        string source = ModEntrySource();
        int start = source.IndexOf("if (this.nativeLocalMoveStallProbePending is NativeLocalMoveStallProbePending stallPending", StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, "probe OnWarped branch not found");
        int end = source.IndexOf("if (this.nativeLocalClearHoeDirtFixturePending is NativeLocalClearHoeDirtFixturePending hoeDirtPending", start, StringComparison.Ordinal);
        end.Should().BeGreaterThan(start, "probe branch must be followed by the hoe-dirt pending branch");
        return source.Substring(start, end - start);
    }

    [Fact]
    public void ProbeWarp_TargetsTheFarm_NotThePlayersCurrentLocation()
    {
        // Live failure: warpFarmer used player.currentLocation's name, so the
        // actor warped to FarmHouse and OnWarped (which checks the pending farm
        // name) never fired; the bridge then timed out waiting for a fixture
        // that was never initialized.
        string source = ModEntrySource();
        string fixture = MethodBody(source, "private void InitializeNativeLocalMoveStallProbeFixture(Farmer player, Farm farm, bool useHorseBlock)");
        fixture.Should().Contain("player.warpFarmer(new StardewValley.Warp(0, 0, farm.NameOrUniqueName", 
            "the probe warp must target the farm the anchor was scanned on");
        fixture.Should().Contain("this.nativeLocalMoveStallProbePending = new NativeLocalMoveStallProbePending(farm.NameOrUniqueName,",
            "the pending record must name the same farm for OnWarped to match");
    }

    [Fact]
    public void ProbeAnchorWalkable_ExcludesOnlyTheFarmersClass()
    {
        // Live failure: IsTileOccupiedBy(CollisionMask.All, useFarmerTile: true)
        // counts the JUST-WARPED actor as occupying its own anchor tile, so the
        // three-collinear line always failed its own precondition. The mask must
        // exclude Farmers (the actor) while still counting every other class.
        string body = MethodBody(ModEntrySource(), "private static bool IsMoveStallLineWalkable(GameLocation location, Vector2 a, Vector2 b, Vector2 c)");
        body.Should().Contain("~CollisionMask.Farmers", "the actor's own Farmers class must not fail the anchor line");
        body.Should().NotContain("CollisionMask.All,", "every-class occupancy would count the just-warped actor itself");
        body.Should().Contain("useFarmerTile: false", "farmer-tile semantics must not be consulted for the actor's own anchor");
    }

    [Fact]
    public void ProbeAnchor_UsesTheNativePlannerAndRequiresCrossingTheBlocker()
    {
        // Live failure: a cheap isTilePassable scan selected a Farm column the
        // native A* refused (no_native_path), so the probe never exercised the
        // blocker at all. The anchor must be verified with the same findPath
        // the move action uses, and the path must actually cross the blocker.
        string source = ModEntrySource();
        string scan = MethodBody(source, "private static Vector2? FindNativeLocalMoveStallAnchor(GameLocation location)");
        scan.Should().Contain("PlannerRoutesThrough(location, a, b, c)", "anchor selection must consult the native planner");
        string planner = MethodBody(source, "private static bool PlannerRoutesThrough(GameLocation location, Vector2 a, Vector2 b, Vector2 c)");
        planner.Should().Contain("PathFindController.findPath(", "the fixture must use the same native A* the action uses");
        planner.Should().Contain("path.Any(tile => tile.X == blocker.X && tile.Y == blocker.Y)",
            "the planned path must cross the blocker tile for the probe's Given to hold");
        // Causal ordering inside the probe's OnWarped branch: the line geometry is
        // verified (including the planner routing through the middle tile) BEFORE
        // the blocker is placed. The blocker did not exist during verification, so
        // a pass proved the three tiles were a genuine open line; the blocker then
        // turns that verified line into the runtime collision the probe measures.
        string onWarped = ProbeOnWarpedBranch();
        int check = onWarped.IndexOf("fixture_native_move_stall_post_warp_geometry_failed", StringComparison.Ordinal);
        int place = onWarped.IndexOf("location.addCharacter(", StringComparison.Ordinal);
        check.Should().BeGreaterThanOrEqualTo(0);
        place.Should().BeGreaterThan(check, "geometry must be verified before the blocker is placed");
    }

    [Fact]
    public void ProbeOnWarped_PlacesTheBlockerAfterTheWarpSettles_OnTheActualActorTile()
    {
        // The warp completes through the native lifecycle, so the blocker must
        // be placed in OnWarped against the ACTUAL post-warp tile, not derived
        // from the pre-warp anchor.
        string body = ProbeOnWarpedBranch();
        body.Should().Contain("e.Player == Game1.player",
            "the probe pending must be consumed in OnWarped for the local player");
        body.Should().Contain("Vector2 actualA = e.Player.Tile;", "the blocker line must derive from the settled post-warp tile");
        body.Should().Contain("fixture_native_move_stall_warp_wrong_location",
            "a warp to the wrong location must be a named fixture failure, not a silent no-op");
        body.Should().Contain("fixture_native_move_stall_post_warp_geometry_failed",
            "a post-warp geometry failure must be a named fixture failure, not a silent no-op");
        body.Should().Contain("this.nativeLocalPlayerFixtureInitialized = true;",
            "the probe must not claim initialized before OnWarped completes the geometry");
    }

    [Fact]
    public void ProbeRegistrations_AreComplete_AcrossAllScenarioAllowLists()
    {
        string modEntry = ModEntrySource();
        string modConfig = File.ReadAllText(RepositorySourcePath(Path.Combine("integrations", "stardew", "ModConfig.cs")));
        foreach (string scenario in new[] { "native_move_stall_probe_pet_v1", "native_move_stall_probe_npc_v1" })
        {
            modEntry.Should().Contain($"if (fixture.FixtureScenario is \"native_move_stall_probe_pet_v1\" or \"native_move_stall_probe_npc_v1\")",
                $"{scenario} must dispatch to the probe fixture initializer");
            modEntry.Should().Contain($"\"{scenario}\"", $"{scenario} must be in ModEntry's pre-attachment allow list");
            modConfig.Should().Contain($"\"{scenario}\"", $"{scenario} must be in ModConfig's KnownFixtureScenarios");
        }
    }
}