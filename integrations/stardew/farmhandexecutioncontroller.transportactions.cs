using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Menus;
using StardewValley.Tools;
using StardewValley.Characters;
using StardewValley.Locations;
using GameBuddy.Stardew.Core.Models;
using MineFloorCapability = GameBuddy.Stardew.Core.MineFloorCapability;

namespace GameBuddy.Stardew;

internal sealed partial class ExecutionManager
{

    internal static IEnumerable<Vector2> AdjacentCardinalTiles(Farmer player)
    {
        Vector2 origin = player.Tile;
        yield return origin + new Vector2(0, -1);
        yield return origin + new Vector2(1, 0);
        yield return origin + new Vector2(0, 1);
        yield return origin + new Vector2(-1, 0);
    }

    internal static string BuildRaftTargetId(GameLocation location, int x, int y) =>
        $"raft_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes($"{location.NameOrUniqueName}:{x},{y}"))).ToLowerInvariant()[..16]}";

    internal static string BuildHorseTargetId(GameLocation location, Horse horse) =>
        $"horse_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes($"{location.NameOrUniqueName}:{horse.HorseId}"))).ToLowerInvariant()[..16]}";

    /// <summary>The mine entrance map's own <c>Action</c> selector.</summary>
    internal const string MineEntranceSelector = "Mine";
    /// <summary>The ladder-down selector of this same opaque id family.</summary>
    internal const string MineLadderSelector = "MineLadder";
    /// <summary>The ladder-up (exit) selector of this same opaque id family.</summary>
    internal const string MineExitLadderSelector = "MineExitLadder";
    /// <summary>The descending ladder's Buildings-layer tile index in a mine level (MineShaft.cs:3083).</summary>
    private const int MineLadderTileIndex = 173;
    /// <summary>The exit ladder's Buildings-layer tile index in a mine level (MineShaft.cs:3073).</summary>
    private const int MineExitLadderTileIndex = 115;
    /// <summary>The question key the 115 branch itself opens (MineShaft.cs:3080).</summary>
    internal const string MineExitQuestionKey = "ExitMine";
    /// <summary>The one response that leaves; the tile offers Leave and Do nothing (MineShaft.cs:3077-3078).</summary>
    internal const string MineExitResponseKey = "Leave";
    /// <summary>Skull Cavern's entrance map, where `ExitMine_Leave` sends an actor past level 120.</summary>
    internal const string SkullCavernEntranceLocation = "SkullCave";
    /// <summary>
    /// The secret woods shaft's level number. `ExitMine_Leave` treats it as the exception it is and returns the actor to
    /// the Mine entrance at 67,10 rather than 23,8 (GameLocation.cs:12390-12392).
    /// </summary>
    internal const int SecretWoodsMineLevel = 77377;
    /// <summary>Where `ExitMine_Leave` lands an actor leaving an ordinary mine level.</summary>
    internal const int MineExitTileX = 23;
    internal const int MineExitTileY = 8;

    /// <summary>
    /// The descent tile of a mine level, found the same way the elevator tile is: a
    /// live scan of the level's own Buildings layer, never a client coordinate.
    /// </summary>
    internal static bool TryFindMineLadderTile(GameLocation? location, out int tileX, out int tileY) =>
        TryFindMineTileWithIndex(location, MineLadderTileIndex, out tileX, out tileY);

    /// <summary>
    /// The EXIT tile of a mine level: the same live scan on the ladder-up index. A location that is not a mine level has
    /// neither ladder, so it answers false and the caller turns that into a refusal rather than a coordinate.
    /// </summary>
    internal static bool TryFindMineExitLadderTile(GameLocation? location, out int tileX, out int tileY) =>
        TryFindMineTileWithIndex(location, MineExitLadderTileIndex, out tileX, out tileY);

    private static bool TryFindMineTileWithIndex(GameLocation? location, int tileIndex, out int tileX, out int tileY)
    {
        tileX = 0;
        tileY = 0;
        if (location is not MineShaft shaft)
            return false;
        xTile.Layers.Layer? buildings = shaft.map?.GetLayer("Buildings");
        if (buildings is null)
            return false;
        for (int y = 0; y < buildings.LayerHeight; y++)
        {
            for (int x = 0; x < buildings.LayerWidth; x++)
            {
                if (buildings.Tiles[x, y]?.TileIndex == tileIndex)
                {
                    tileX = x;
                    tileY = y;
                    return true;
                }
            }
        }
        return false;
    }

    /// <summary>
    /// The opaque id of one live mine-entry object. Three kinds share the family: a
    /// <c>Mine</c> Action tile on the mine entrance map, the descending ladder tile
    /// inside a mine level, and the exit ladder tile there. All keep the published
    /// <c>mine_entrance_&lt;16 hex&gt;</c> wire shape (the Host validates exactly that
    /// prefix and length), and the hash input names the kind, so they can never collide.
    /// </summary>
    internal static string BuildMineEntryTargetId(string locationName, int x, int y, string selector) =>
        $"mine_entrance_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes($"{locationName}:{x},{y}:{selector}"))).ToLowerInvariant()[..16]}";

    private static Horse? ResolveHorseTarget(GameLocation location, string expectedTargetId) =>
        location.characters.OfType<Horse>().FirstOrDefault(candidate =>
            string.Equals(BuildHorseTargetId(location, candidate), expectedTargetId, StringComparison.Ordinal)
            && candidate.rider is null
            && !string.IsNullOrWhiteSpace(candidate.Name)
            && !string.Equals(candidate.Name, "Horse", StringComparison.Ordinal));

    public LocalExecutionReceipt RequestLocalMountTransport(string requestId, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.AdmitLocalExecution(requestId, requestedDeadlineMs, AdmissionActionabilityProfile.Physical, out string executionId, out long nowMs) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;
        GameLocation location = Game1.player.currentLocation;
        Horse? horse = ResolveHorseTarget(location, expectedTargetId);
        if (horse is null) return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "horse_target_unavailable", $"target={expectedTargetId}");
        if (Game1.player.CurrentItem is StardewValley.Objects.Hat || Game1.player.CurrentItem?.QualifiedItemId == "(O)Carrot")
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "horse_interaction_item_interference",
                $"held={(Game1.player.CurrentItem?.QualifiedItemId ?? "none")}");
        int horseTileX = (int)horse.Tile.X;
        int horseTileY = (int)horse.Tile.Y;
        if (!IsTileWithinChebyshevRadius(Game1.player, horseTileX, horseTileY, 1))
            return this.TryBeginToolApproach(requestId, executionId, "mount_transport", location, horseTileX, horseTileY, expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteMountTransport(arrivalExecutionId, arrivalRequestId, expectedTargetId, requestedDeadlineMs), nowMs, requestedDeadlineMs);

        return this.ExecuteMountTransport(executionId, requestId, expectedTargetId, requestedDeadlineMs);
    }

    private LocalExecutionReceipt ExecuteMountTransport(string executionId, string requestId, string expectedTargetId, long requestedDeadlineMs)
    {
        GameLocation location = Game1.player.currentLocation;
        Horse? horse = ResolveHorseTarget(location, expectedTargetId);
        if (horse is null) return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "horse_target_unavailable", $"target={expectedTargetId}");
        if (Game1.player.CurrentItem is StardewValley.Objects.Hat || Game1.player.CurrentItem?.QualifiedItemId == "(O)Carrot")
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "horse_interaction_item_interference",
                $"held={(Game1.player.CurrentItem?.QualifiedItemId ?? "none")}");
        int horseTileX = (int)horse.Tile.X;
        int horseTileY = (int)horse.Tile.Y;
        if (!IsTileWithinChebyshevRadius(Game1.player, horseTileX, horseTileY, 1))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "horse_target_out_of_range",
                $"target={expectedTargetId};horse={horseTileX},{horseTileY};actor_tile={Game1.player.TilePoint.X},{Game1.player.TilePoint.Y};reach=1;approach=target_moved");

        LocalMountTransportSpec specification = new(executionId, requestId, location.NameOrUniqueName, horseTileX, horseTileY, expectedTargetId, horse.HorseId, requestedDeadlineMs);
        this.slots.MountTransport.Assign(specification);
        bool handled = horse.checkAction(Game1.player, location);
        if (!handled)
        {
            this.slots.MountTransport.Clear();
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "horse_action_not_handled", $"target={expectedTargetId}");
        }
        return this.RememberTerminal(requestId, executionId, ExecutionState.Accepted, "horse_mount_pending", $"target={expectedTargetId};tile={horseTileX},{horseTileY};horse_id={horse.HorseId}");
    }

    public LocalExecutionReceipt RequestLocalEnterMine(string requestId, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.AdmitLocalExecution(requestId, requestedDeadlineMs, AdmissionActionabilityProfile.Physical, out string executionId, out long nowMs) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;
        GameLocation location = Game1.player.currentLocation;

        // Inside a mine the way down is that level's own ladder tile, not the
        // entrance map's `Mine` Action. The native branch it mirrors is
        // `MineShaft.checkAction` case 173 -> `Game1.enterMine(mineLevel + 1)`
        // (MineShaft.cs:3083-3086), so the target level is native state (the level
        // the actor is already on, plus one) and never a client-supplied value.
        if (location is MineShaft)
        {
            MineLadderTargetResolution ladder = ResolveMineLadderTarget(location, targetX, targetY, expectedTargetId, MineLadderKind.Descend);
            if (!ladder.Accepted)
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, ladder.RefusalCode, ladder.Evidence);
            if (this.RefuseDescentIntoMonsters(requestId, executionId, location, ((MineShaft)location).mineLevel + 1, attempt: "ladder_request") is { } refusedDescent)
                return refusedDescent;
            if (!IsTileWithinChebyshevRadius(Game1.player, ladder.TileX, ladder.TileY, 1))
                return this.TryBeginToolApproach(requestId, executionId, "enter_mine", location, ladder.TileX, ladder.TileY, expectedTargetId,
                    (arrivalExecutionId, arrivalRequestId) => this.ExecuteEnterMineLadder(arrivalExecutionId, arrivalRequestId, targetX, targetY, expectedTargetId, requestedDeadlineMs), nowMs, requestedDeadlineMs);

            return this.ExecuteEnterMineLadder(executionId, requestId, targetX, targetY, expectedTargetId, requestedDeadlineMs);
        }

        MineEntranceTargetResolution entrance = ResolveMineEntrance(location, targetX, targetY, expectedTargetId);
        if (!entrance.Accepted)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "mine_entrance_target_unavailable", entrance.Evidence);
        if (!IsTileWithinChebyshevRadius(Game1.player, entrance.TileX, entrance.TileY, 1))
            return this.TryBeginToolApproach(requestId, executionId, "enter_mine", location, entrance.TileX, entrance.TileY, expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteEnterMineEntrance(arrivalExecutionId, arrivalRequestId, targetX, targetY, expectedTargetId, requestedDeadlineMs), nowMs, requestedDeadlineMs);

        return this.ExecuteEnterMineEntrance(executionId, requestId, targetX, targetY, expectedTargetId, requestedDeadlineMs);
    }

    private LocalExecutionReceipt ExecuteEnterMineLadder(string executionId, string requestId, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        GameLocation location = Game1.player.currentLocation;
        MineLadderTargetResolution ladder = ResolveMineLadderTarget(location, targetX, targetY, expectedTargetId, MineLadderKind.Descend);
        if (!ladder.Accepted)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, ladder.RefusalCode, ladder.Evidence);
        if (!IsTileWithinChebyshevRadius(Game1.player, ladder.TileX, ladder.TileY, 1))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "mine_ladder_out_of_range",
                $"ladder={ladder.TileX},{ladder.TileY};actor_tile={Game1.player.TilePoint.X},{Game1.player.TilePoint.Y};reach=1;approach=did_not_arrive");

        MineShaft shaft = (MineShaft)location;
        int descentLevel = shaft.mineLevel + 1;
        if (this.RefuseDescentIntoMonsters(requestId, executionId, location, descentLevel, attempt: "ladder") is { } refusedDescent)
            return refusedDescent;
        Game1.enterMine(descentLevel);
        if (Game1.player.currentLocation is MineShaft descended && descended.mineLevel == descentLevel)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "mine_entered", $"level={descended.mineLevel};tile={Game1.player.TilePoint.X},{Game1.player.TilePoint.Y};from_level={shaft.mineLevel}");
        LocalTravelSpec descentSpecification = new(executionId, requestId, "enter_mine", shaft.NameOrUniqueName, ladder.TileX, ladder.TileY, MineShaft.GetLevelName(descentLevel), 6, 6, this.revision, requestedDeadlineMs);
        this.slots.Travel.Assign(descentSpecification);
        return this.RememberTerminal(requestId, executionId, ExecutionState.Accepted, "mine_entry_pending", $"source={shaft.NameOrUniqueName}:{ladder.TileX},{ladder.TileY};target={descentSpecification.TargetLocation}:6,6;level={descentLevel}");
    }

    private LocalExecutionReceipt ExecuteEnterMineEntrance(string executionId, string requestId, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        GameLocation location = Game1.player.currentLocation;
        MineEntranceTargetResolution entrance = ResolveMineEntrance(location, targetX, targetY, expectedTargetId);
        if (!entrance.Accepted)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "mine_entrance_target_unavailable", entrance.Evidence);
        if (!IsTileWithinChebyshevRadius(Game1.player, entrance.TileX, entrance.TileY, 1))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "mine_entrance_out_of_range",
                $"tile={entrance.TileX},{entrance.TileY};actor_tile={Game1.player.TilePoint.X},{Game1.player.TilePoint.Y};reach=1;approach=did_not_arrive");

        int declaredLevel = entrance.DeclaredLevel;
        // The entrance map declares which floor it enters (`case "Mine"`, GameLocation.cs:9807-9816), so that value is
        // the one this surface has to be able to answer.
        if (this.RefuseDescentIntoMonsters(requestId, executionId, location, declaredLevel, attempt: "entrance") is { } refusedEntrance)
            return refusedEntrance;
        Game1.enterMine(declaredLevel);
        if (Game1.player.currentLocation is MineShaft mine && mine.mineLevel == declaredLevel)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "mine_entered", $"level={mine.mineLevel};tile={Game1.player.TilePoint.X},{Game1.player.TilePoint.Y}");
        LocalTravelSpec specification = new(executionId, requestId, "enter_mine", location.NameOrUniqueName, entrance.TileX, entrance.TileY, MineShaft.GetLevelName(declaredLevel), 6, 6, this.revision, requestedDeadlineMs);
        this.slots.Travel.Assign(specification);
        return this.RememberTerminal(requestId, executionId, ExecutionState.Accepted, "mine_entry_pending", $"source={location.NameOrUniqueName}:{entrance.TileX},{entrance.TileY};target={specification.TargetLocation}:6,6;level={declaredLevel}");
    }

    private LocalExecutionReceipt? RefuseDescentIntoMonsters(
        string requestId,
        string executionId,
        GameLocation location,
        int targetFloor,
        string attempt)
    {
        if (MineFloorCapability.IsMonsterFree(targetFloor))
            return null;
        return this.RememberTerminal(
            requestId,
            executionId,
            ExecutionState.Rejected,
            MineFloorCapability.RefusalReasonCode,
            $"{MineFloorCapability.DescribeRefusal(targetFloor)};attempt={attempt};{DescribeHostilesOnCurrentFloor(location)}");
    }

    private static string DescribeHostilesOnCurrentFloor(GameLocation location)
    {
        int hostiles = 0;
        foreach (NPC character in location.characters)
        {
            if (character is StardewValley.Monsters.Monster)
                hostiles += 1;
        }

        int floor = location is MineShaft shaft ? shaft.mineLevel : 0;
        return $"current_floor={floor};hostiles={hostiles}";
    }

    /// <summary>
    /// Leaves the mine level through its own exit ladder.
    ///
    /// <para>
    /// Boundary: the native seam is the LEVEL's own <c>checkAction</c>, not a warp this body invents.
    /// <c>MineShaft.checkAction</c> switches on the Buildings-layer tile index (:3057) and case 115 opens the
    /// <c>ExitMine</c> question with the game's own two responses, Leave and Do nothing (:3073-3081). This body drives
    /// exactly that: the tile is re-read from the live layer, the game opens its question, and the answer is
    /// "Leave", settled through the same location leaf <c>answer_dialogue</c> uses. The warp is performed by the game
    /// inside <c>answerDialogueAction</c> (case <c>ExitMine_Leave</c>, GameLocation.cs:12388-12401), so no coordinate of
    /// ours becomes the destination.
    /// </para>
    /// <para>
    /// Why it exists: measured 2026-11-03 (round30) a companion that had taken <c>enter_mine</c> was published no
    /// ladder at all on a freshly generated level and stayed there until it passed out at 02:00, losing the next day.
    /// The way OUT is the one tile every mine level carries.
    /// </para>
    /// </summary>
    public LocalExecutionReceipt RequestLocalUseMineLadder(string requestId, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.AdmitLocalExecution(requestId, requestedDeadlineMs, AdmissionActionabilityProfile.Physical, out string executionId, out long nowMs) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        GameLocation location = Game1.player.currentLocation;
        MineLadderTargetResolution exit = ResolveMineLadderTarget(location, targetX, targetY, expectedTargetId, MineLadderKind.Exit);
        if (!exit.Accepted)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, exit.RefusalCode, exit.Evidence);
        if (!IsTileWithinChebyshevRadius(Game1.player, exit.TileX, exit.TileY, 1))
            return this.TryBeginToolApproach(requestId, executionId, "use_mine_ladder", location, exit.TileX, exit.TileY, expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteUseMineLadder(arrivalExecutionId, arrivalRequestId, targetX, targetY, expectedTargetId, requestedDeadlineMs), nowMs, requestedDeadlineMs);

        return this.ExecuteUseMineLadder(executionId, requestId, targetX, targetY, expectedTargetId, requestedDeadlineMs);
    }

    private LocalExecutionReceipt ExecuteUseMineLadder(string executionId, string requestId, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        GameLocation location = Game1.player.currentLocation;
        MineLadderTargetResolution exit = ResolveMineLadderTarget(location, targetX, targetY, expectedTargetId, MineLadderKind.Exit);
        if (!exit.Accepted)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, exit.RefusalCode, exit.Evidence);
        if (!IsTileWithinChebyshevRadius(Game1.player, exit.TileX, exit.TileY, 1))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "mine_exit_ladder_out_of_range",
                $"ladder={exit.TileX},{exit.TileY};actor_tile={Game1.player.TilePoint.X},{Game1.player.TilePoint.Y};reach=1;approach=did_not_arrive");

        MineShaft shaft = (MineShaft)location;
        string origin = shaft.NameOrUniqueName;
        int originLevel = shaft.mineLevel;
        (string destinationLocation, int destinationX, int destinationY) = MineExitDestination(originLevel);

        bool handled;
        try
        {
            handled = shaft.checkAction(new xTile.Dimensions.Location(exit.TileX, exit.TileY), Game1.viewport, Game1.player);
        }
        catch (Exception nativeException)
        {
            return this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "mine_exit_native_exception",
                $"from={origin}:{originLevel};ladder={exit.TileX},{exit.TileY};native_dispatched=false;native_exception={nativeException.GetType().Name}");
        }
        if (!handled)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "mine_exit_ladder_not_handled",
                $"from={origin}:{originLevel};ladder={exit.TileX},{exit.TileY};native_handled=false");

        this.RegisterModalOwner(executionId);

        DialogueBox? question = Game1.activeClickableMenu as DialogueBox;
        string questionKey = shaft.lastQuestionKey ?? string.Empty;
        string offeredKeys = question?.responses is { Length: > 0 } offeredResponses
            ? string.Join(",", offeredResponses.Select(response => response.responseKey))
            : string.Join(",", (Game1.questionChoices ?? new List<Response>()).Select(response => response.responseKey));
        bool answerOffered = question is not null
            && question.isQuestion
            && string.Equals(questionKey, MineExitQuestionKey, StringComparison.Ordinal)
            && offeredKeys.Split(',').Contains(MineExitResponseKey, StringComparer.Ordinal);
        if (!answerOffered)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "mine_exit_question_not_offered",
                $"from={origin}:{originLevel};ladder={exit.TileX},{exit.TileY};modal_type={(Game1.activeClickableMenu?.GetType().Name ?? "none")};question={(question?.isQuestion ?? false).ToString().ToLowerInvariant()};question_key={(questionKey.Length == 0 ? "none" : questionKey)};response_keys={(offeredKeys.Length == 0 ? "none" : offeredKeys)}");

        bool answered;
        try
        {
            answered = TryAnswerLocationQuestion(new Response(MineExitResponseKey, MineExitResponseKey));
            question!.beginOutro();
        }
        catch (Exception nativeException)
        {
            return this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "mine_exit_native_exception",
                $"from={origin}:{originLevel};question={MineExitQuestionKey};response={MineExitResponseKey};native_dispatched=true;native_exception={nativeException.GetType().Name}");
        }

        if (!answered)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Failed, "mine_exit_answer_not_accepted",
                $"from={origin}:{originLevel};question={MineExitQuestionKey};response={MineExitResponseKey};native_answered=false");

        if (Game1.player.currentLocation is not MineShaft stillInside)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "mine_left",
                $"from={origin}:{originLevel};question={MineExitQuestionKey};response={MineExitResponseKey};ladder={exit.TileX},{exit.TileY};actual={Game1.player.currentLocation?.NameOrUniqueName ?? "none"}:{Game1.player.TilePoint.X},{Game1.player.TilePoint.Y}");

        LocalTravelSpec exitSpecification = new(executionId, requestId, "use_mine_ladder", origin, exit.TileX, exit.TileY, destinationLocation, destinationX, destinationY, this.revision, requestedDeadlineMs);
        this.slots.Travel.Assign(exitSpecification);
        return this.RememberTerminal(requestId, executionId, ExecutionState.Accepted, "mine_exit_pending",
            $"from={origin}:{originLevel};question={MineExitQuestionKey};response={MineExitResponseKey};ladder={exit.TileX},{exit.TileY};target={destinationLocation}:{destinationX},{destinationY};still_in={stillInside.NameOrUniqueName}");
    }

    /// <summary>
    /// Where the game's own <c>ExitMine_Leave</c> response sends the actor, as the three-branch rule it applies to the
    /// CURRENT mine level (GameLocation.cs:12388-12401): the secret woods shaft returns to the Mine entrance at 67,10,
    /// anything past level 120 to the Skull Cavern entrance, and every other level to the Mine entrance at 23,8.
    ///
    /// <para>
    /// The destination has to be restated here because the response performs the warp INSIDE the game, and the travel
    /// record needs a destination to judge arrival - the same shape <c>select_mine_elevator_floor</c> already uses for
    /// the entrance map (MineElevatorMenu.cs:86). A value that drifts from the game's rule cannot produce a false
    /// success: it produces <c>mine_exit_postcondition_mismatch</c>.
    /// </para>
    /// </summary>
    internal static (string Location, int X, int Y) MineExitDestination(int mineLevel) => mineLevel switch
    {
        SecretWoodsMineLevel => (MineEntranceLocation, 67, 10),
        > HighestElevatorMineLevel => (SkullCavernEntranceLocation, 3, 4),
        _ => (MineEntranceLocation, MineExitTileX, MineExitTileY),
    };

    /// <summary>
    /// The leg OUT of the map the body stands on, when that map's way out is not an ordinary warp, as the step a caller
    /// can take and the map it lands on. A mine level is the case: its exits are the ladder tiles its own Buildings layer
    /// carries, never rows of <c>warps</c>, so no navigation graph built from warps and doors has an edge off it.
    ///
    /// <para>
    /// Both halves are read from the authority that already executes the act, not restated: the target id is the SAME
    /// published <c>mine_entrance_&lt;16 hex&gt;</c> id <c>MineEntranceTargets</c> advertises for <c>use_mine_ladder</c>
    /// (<see cref="BuildMineEntryTargetId"/> with <see cref="MineExitLadderSelector"/>), and the landing map is the one
    /// the game's own <c>ExitMine_Leave</c> chooses (<see cref="MineExitDestination"/>). A destination that is not
    /// reachable from this map is therefore answered with where it IS reachable from.
    /// </para>
    /// <para>
    /// MEASURED `round99` (`plan_441`, `plan_443`): `navigate_to_destination` from `UndergroundMine1` to `Farm` answered
    /// twice with `destination_access_indeterminate`, a word that leaves a reader with nothing to plan.
    /// </para>
    /// </summary>
    internal static bool TryDescribeMapExit(GameLocation? location, out string step, out string landing)
    {
        step = string.Empty;
        landing = string.Empty;
        if (location is not MineShaft shaft || !TryFindMineExitLadderTile(shaft, out int exitX, out int exitY))
            return false;

        step = $"use_mine_ladder@{BuildMineEntryTargetId(shaft.NameOrUniqueName, exitX, exitY, MineExitLadderSelector)}";
        landing = MineExitDestination(shaft.mineLevel).Location;
        return true;
    }

    private static MineLadderTargetResolution ResolveMineLadderTarget(GameLocation? location, int targetX, int targetY, string expectedTargetId, MineLadderKind wanted)
    {
        if (location is not MineShaft shaft)
            return new MineLadderTargetResolution(false, wanted, targetX, targetY, "not_in_mine",
                $"expected=MineShaft;actual={location?.NameOrUniqueName ?? "none"};tile={targetX},{targetY}");

        bool namesDescend = TryFindMineLadderTile(shaft, out int descendX, out int descendY)
            && descendX == targetX && descendY == targetY
            && string.Equals(BuildMineEntryTargetId(shaft.NameOrUniqueName, descendX, descendY, MineLadderSelector), expectedTargetId, StringComparison.Ordinal);
        bool namesExit = TryFindMineExitLadderTile(shaft, out int exitX, out int exitY)
            && exitX == targetX && exitY == targetY
            && string.Equals(BuildMineEntryTargetId(shaft.NameOrUniqueName, exitX, exitY, MineExitLadderSelector), expectedTargetId, StringComparison.Ordinal);

        if (wanted == MineLadderKind.Descend)
        {
            if (namesDescend)
                return new MineLadderTargetResolution(true, wanted, descendX, descendY, string.Empty, string.Empty);
            if (namesExit)
                return new MineLadderTargetResolution(false, wanted, exitX, exitY, "mine_ladder_is_exit",
                    $"target={expectedTargetId};tile={exitX},{exitY};mine_level={shaft.mineLevel};use_action=use_mine_ladder");
            return new MineLadderTargetResolution(false, wanted, targetX, targetY, "mine_ladder_target_unavailable",
                $"target={expectedTargetId};tile={targetX},{targetY};mine_level={shaft.mineLevel}");
        }

        if (namesExit)
            return new MineLadderTargetResolution(true, wanted, exitX, exitY, string.Empty, string.Empty);
        if (namesDescend)
            return new MineLadderTargetResolution(false, wanted, descendX, descendY, "mine_ladder_descends",
                $"target={expectedTargetId};tile={descendX},{descendY};mine_level={shaft.mineLevel};use_action=enter_mine");
        return new MineLadderTargetResolution(false, wanted, targetX, targetY, "mine_exit_ladder_target_unavailable",
            $"target={expectedTargetId};tile={targetX},{targetY};expected=MineShaft+Buildings:{MineExitLadderTileIndex};mine_level={shaft.mineLevel};use_action=enter_mine");
    }

    /// <summary>
    /// The mine entrance the request names, with the level its own <c>Action</c> string declares.
    ///
    /// The level is read exactly the way the native click path reads it (<c>GameLocation.performAction</c>
    /// `case "Mine"`: `ArgUtility.TryGetOptionalInt(action, 1, out mineLevel, out error, 1, "int mineLevel")` ->
    /// `Game1.enterMine(mineLevel)`, GameLocation.cs:9807-9816), so the entered level is the facility's own declaration
    /// rather than a value derived from the actor's progress. A malformed parameter is the same refusal the native path
    /// produces (it logs an error and enters nothing).
    /// NOTE (unverified): the shipped map data is xnb and cannot be read from here, so which literal the live entrance
    /// declares is deliberately NOT asserted: whatever the tile declares is what gets entered.
    /// </summary>
    private static MineEntranceTargetResolution ResolveMineEntrance(GameLocation location, int targetX, int targetY, string expectedTargetId)
    {
        string? action = location.doesTileHaveProperty(targetX, targetY, "Action", "Buildings");
        string[] actionTokens = ArgUtility.SplitBySpace(action ?? string.Empty);
        if (action is null
            || !string.Equals(BuildMineEntryTargetId(location.NameOrUniqueName, targetX, targetY, MineEntranceSelector), expectedTargetId, StringComparison.Ordinal)
            || !string.Equals(actionTokens.FirstOrDefault(), MineEntranceSelector, StringComparison.Ordinal)
            || !ArgUtility.TryGetOptionalInt(actionTokens, 1, out int declaredLevel, out _, 1, "int mineLevel"))
            return new MineEntranceTargetResolution(false, targetX, targetY, 0, $"tile={targetX},{targetY};action={action ?? "none"}");

        return new MineEntranceTargetResolution(true, targetX, targetY, declaredLevel, string.Empty);
    }

    public LocalExecutionReceipt RequestLocalUseRaft(string requestId, int slot, int targetX, int targetY, long requestedDeadlineMs)
    {
        if (this.AdmitLocalExecution(requestId, requestedDeadlineMs, AdmissionActionabilityProfile.Physical, out string executionId, out long nowMs) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        Farmer player = Game1.player;
        GameLocation location = player.currentLocation;
        if (ResolveDeclaredTool(player.Items, "use_raft").RefusalCode is { } toolRefusal)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, toolRefusal, $"slot={slot}");
        if (!location.isWaterTile(targetX, targetY))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "raft_target_not_water",
                $"tile={targetX},{targetY};location={location.NameOrUniqueName};is_water=false;actor_tile={player.TilePoint.X},{player.TilePoint.Y}");
        if (!IsTileWithinChebyshevRadius(player, targetX, targetY, 1))
            return this.TryBeginToolApproach(requestId, executionId, "use_raft", location, targetX, targetY, BuildRaftTargetId(location, targetX, targetY),
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteUseRaft(arrivalExecutionId, arrivalRequestId, slot, targetX, targetY), nowMs, requestedDeadlineMs);

        return this.ExecuteUseRaft(executionId, requestId, slot, targetX, targetY);
    }

    private LocalExecutionReceipt ExecuteUseRaft(string executionId, string requestId, int slot, int targetX, int targetY)
    {
        Farmer player = Game1.player;
        GameLocation location = player.currentLocation;
        if (!TrySelectDeclaredTool(player, "use_raft", out DeclaredToolSelection selection, out string toolRefusalCode))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, toolRefusalCode, $"slot={slot}");
        try
        {
            if (selection.Tool is not Raft raft)
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, $"tool_not_selected:{selection.Category}", $"slot={selection.Slot}");
            if (!location.isWaterTile(targetX, targetY))
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "raft_target_not_water",
                    $"tile={targetX},{targetY};location={location.NameOrUniqueName};is_water=false;actor_tile={player.TilePoint.X},{player.TilePoint.Y}");
            if (!IsTileWithinChebyshevRadius(player, targetX, targetY, 1))
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "raft_target_out_of_range",
                    $"tile={targetX},{targetY};actor_tile={player.TilePoint.X},{player.TilePoint.Y};reach=1;approach=did_not_arrive");

            float staminaBefore = player.Stamina;
            bool raftingBefore = player.isRafting;
            raft.DoFunction(location, targetX * 64 + 32, targetY * 64 + 32, 1, player);
            bool launched = !raftingBefore && player.isRafting;
            if (!launched && player.Stamina != staminaBefore)
                return this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "raft_launch_postcondition_unavailable", $"tile={targetX},{targetY};is_rafting={player.isRafting.ToString().ToLowerInvariant()};stamina_changed=true");
            return this.RememberTerminal(requestId, executionId, launched ? ExecutionState.Succeeded : ExecutionState.Rejected,
                launched ? "raft_launched" : "raft_launch_not_started",
                $"tile={targetX},{targetY};is_rafting={player.isRafting.ToString().ToLowerInvariant()};stamina_before={staminaBefore:0.####};stamina_after={player.Stamina:0.####}");
        }
        finally
        {
            RestoreToolSelection(player, selection);
        }
    }

    /// <summary>Which of the two ladder kinds a request may name; each kind has exactly one owner action.</summary>
    internal enum MineLadderKind
    {
        Descend,
        Exit,
    }

    private sealed record MineLadderTargetResolution(bool Accepted, MineLadderKind Kind, int TileX, int TileY, string RefusalCode, string Evidence);

    private sealed record MineEntranceTargetResolution(bool Accepted, int TileX, int TileY, int DeclaredLevel, string Evidence);

}
