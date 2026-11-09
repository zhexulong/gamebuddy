using System.Globalization;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Menus;
using StardewValley.Tools;

namespace GameBuddy.Stardew;

/// <summary>
/// `fish_here`: cast at a water tile the ENGINE says a rod may be cast at, wait for the engine's own bite, and then let
/// the engine's own win path credit the catch.
///
/// <para>
/// WHY THIS SHAPE. The card's original premise was that `FishingRod.doneFishing` books a catch. It does not:
/// `doDoneFishing` (`FishingRod.cs:1749-1825`) consumes bait and tackle, clears the rod's own flags and hands the body
/// back - `farmer.fishCaught` is untouched. The engine credits a catch in exactly one place, `playerCaughtFishEndFunction`
/// (`:1086-1135`, `farmer.caughtFish(...)` at `:1104`), reached only through `pullFishFromWater(...)` (`:1137`), which the
/// minigame calls on its win (`BobberBar.cs:361`) and which `doneHoldingFish` (`:2304`) follows with the bait/tackle
/// settle and the inventory add once the player acknowledges the fish.
/// </para>
///
/// <para>
/// WHAT IS SKIPPED is the bar's per-frame holding, and nothing else. Every number the receipt carries is read from the
/// engine's own objects: the fish from `location.getFish` inside `DoFunction`'s nibble branch (`:491`), the size, quality
/// and difficulty from the `BobberBar` the engine constructs for THIS catch (`:891-940`, `BobberBar.cs:181-195`), and the
/// stamina/bait/tackle deltas from the engine's own mutations. No size formula, no difficulty roll and no fish table lives
/// in this file.
/// </para>
/// </summary>
internal sealed partial class ExecutionManager
{
    /// <summary>
    /// The cap on published cast tiles, equal to the Host's `maxItems` for `waterTargets`: one entry past it would close
    /// the bridge rather than shorten the list.
    /// </summary>
    private const int MaximumWaterTargets = 32;

    private LocalFishingCastSpec? activeFishing;

    /// <summary>
    /// The tiles a rod may be cast at here, WHOLE MAP, nearest first.
    ///
    /// <para>
    /// The predicate is the engine's own pair, asked exactly as the cast asks it (`FishingRod.cs:411`):
    /// <c>location.canFishHere()</c> and <c>location.isTileFishable(tileX, tileY)</c>. `isTileFishable` is where a
    /// `NoFishing` tile, a water tile under a building, and a fishable building (a FishPond) all arrive as the engine's
    /// answer rather than as a second reading of the map.
    /// </para>
    ///
    /// <para>
    /// The surrounding standable set is the same rule the water landmark already uses
    /// (`DerivedDestinationSet.TryCreateWaterLandmark`): a water tile is impassable, so the row is only a target while a
    /// cardinal neighbour is somewhere this body may stand. It is asked of `StardewBodyController.IsStandableTile` - the
    /// body's own answer, not the map's - so discovery can never publish a row the walk refuses.
    /// </para>
    ///
    /// <para>
    /// WHY NEAREST FIRST AND CAPPED. Every dropped row is strictly farther than every published one, which is the one
    /// truncation a fishing plan cannot be misled by. Reachability is decided by the WALK, never by this list.
    /// </para>
    /// </summary>
    internal static IReadOnlyList<BridgeWaterTarget> DiscoverWaterTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location?.map is null || location.map.Layers.Count == 0) return Array.Empty<BridgeWaterTarget>();
        if (!location.canFishHere()) return Array.Empty<BridgeWaterTarget>();
        int width = location.map.Layers[0].LayerWidth;
        int height = location.map.Layers[0].LayerHeight;
        List<(int X, int Y)> candidates = new();
        for (int y = 0; y < height; y++)
        for (int x = 0; x < width; x++)
        {
            if (!location.isTileFishable(x, y)) continue;
            if (!HasCastEdge(location, player, x, y)) continue;
            candidates.Add((x, y));
        }
        return candidates
            .OrderBy(tile => ChebyshevDistance(player, tile.X, tile.Y))
            .ThenBy(tile => tile.X)
            .ThenBy(tile => tile.Y)
            .Take(MaximumWaterTargets)
            .Select(tile => new BridgeWaterTarget(BuildWaterTargetId(location, tile.X, tile.Y), tile.X, tile.Y))
            .ToArray();
    }

    private static bool HasCastEdge(GameLocation location, Farmer player, int x, int y)
    {
        foreach ((int nx, int ny) in new[] { (x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1) })
            if (StardewBodyController.IsStandableTile(location, player, new Vector2(nx, ny)))
                return true;
        return false;
    }

    /// <summary>
    /// The address one water tile is bound with, recomputed by the handler before it casts. `internal` for the same reason
    /// `BuildCropTargetId` is: the round-trip test must ask the PRODUCTION function rather than keep a second copy of the
    /// hash, so discovery and execution cannot disagree behind a green test.
    /// </summary>
    internal static string BuildWaterTargetId(GameLocation location, int x, int y)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:water";
        return $"water_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    /// <summary>
    /// Admission for one cast: identity, actionability, deadline and body exclusivity through the shared seam, then the
    /// target binding and the geometry. Out of the native reach the actor WALKS to the water's edge and the same body
    /// runs on arrival - a refusal there would be a distance, not a reason.
    /// </summary>
    public LocalExecutionReceipt RequestLocalFishHere(string requestId, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.Physical) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;
        GameLocation? location = Game1.player.currentLocation;
        if (location is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        // The caller's own binding first: an id that no longer names this tile means the water it named is not the water
        // it is asking about, which is a different fact from "this water cannot be fished".
        if (!string.Equals(BuildWaterTargetId(location, targetX, targetY), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "water_not_fishable:target_changed",
                $"target={expectedTargetId};tile={targetX},{targetY};actual={BuildWaterTargetId(location, targetX, targetY)};blocked_by={new RefusalLayerToken(RefusalLayerKind.LocationConstraint, "target_changed").Format()}");
        // Ask before walking: a pack that cannot cast is refused NOW rather than after an approach leg the action could
        // never finish - the same order `refill_watering_can` keeps. The refusal is re-asked on arrival, because the pack
        // and the actor move during the walk.
        if (this.RefuseCastingRig(requestId, executionId) is LocalExecutionReceipt rigRefusal)
            return rigRefusal;
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
            return this.TryBeginToolApproach(
                requestId,
                executionId,
                "fish_here",
                location,
                targetX,
                targetY,
                expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteFishHere(arrivalExecutionId, arrivalRequestId, targetX, targetY, expectedTargetId, requestedDeadlineMs),
                nowMs,
                requestedDeadlineMs);
        return this.ExecuteFishHere(executionId, requestId, targetX, targetY, expectedTargetId, requestedDeadlineMs);
    }

    /// <summary>
    /// The three facts about the ACTOR and her rig, as one refusal or nothing: a rod in the pack, a bait that rod needs, and
    /// enough stamina to cast. It mutates nothing (it does not select the rod), so it can be asked before a walk and again on
    /// arrival without leaving a tool held.
    ///
    /// <para>
    /// ONE implementation for both asks. The pair would otherwise be two places for "why can she not cast" to disagree, and
    /// the walk would be the only place that knew the answer had changed.
    /// </para>
    /// </summary>
    private LocalExecutionReceipt? RefuseCastingRig(string requestId, string executionId)
    {
        // The pack's own answer. `ResolveDeclaredTool` reads the action's `tool:fishing_rod` claim and reports the ONE word
        // that explains an empty pack, so this file does not keep a second opinion about which tool a rod is.
        DeclaredToolResolution resolution = ResolveDeclaredTool(Game1.player.Items, "fish_here");
        if (resolution.RefusalCode is { } rodRefusal)
        {
            string code = string.Equals(rodRefusal, "tool_not_owned:fishing_rod", StringComparison.Ordinal) ? "no_rod_in_inventory" : "rod_not_equipped";
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, code,
                DescribeDeclaredToolRefusal(Game1.player.Items, "fish_here", rodRefusal));
        }
        if (resolution.Slot < 0 || resolution.Slot >= Game1.player.Items.Count || Game1.player.Items[resolution.Slot] is not FishingRod rod)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "rod_not_equipped",
                $"slot={resolution.Slot};claim={resolution.Category};resolved=a_non_rod;blocked_by={new RefusalLayerToken(RefusalLayerKind.Tool, resolution.Category).Format()}");
        // Bait is only required by a rod that TAKES bait (`FishingRod.CanUseBait` = `numAttachmentSlots > 0`, Tool.cs:189),
        // so the training and bamboo rods are never refused for a bait they cannot hold.
        if (rod.CanUseBait() && rod.GetBait() is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "no_bait_available",
                $"rod={rod.QualifiedItemId};slot={resolution.Slot};rod_takes_bait=true;blocked_by={new RefusalLayerToken(RefusalLayerKind.Item, "bait_required").Format()}");
        // The engine's own stamina gate is `beginUsing`'s opening line (`FishingRod.cs:1647`): at or below one point the rod
        // emotes and returns without fishing. Refusing here rather than there is what keeps the cast from consuming it.
        if (Game1.player.Stamina <= 1f)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "out_of_stamina",
                $"stamina={Game1.player.Stamina.ToString("0.####", CultureInfo.InvariantCulture)};required=more_than_1;blocked_by={new RefusalLayerToken(RefusalLayerKind.Stamina, "one_cast").Format()}");
        return null;
    }

    /// <summary>
    /// The four refusals, and then the cast. EVERY refusal here happens before a byte is thrown: no stamina spent, no bait
    /// consumed, no tackle use, no line in the water. There is deliberately no settlement-time "it got away" code - the
    /// rod's own state machine is allowed to finish a cast once it has started, and the only settlement surprise left is
    /// the deadline, which is a body budget rather than a verdict about the catch.
    ///
    /// <para>
    /// The rod stays SELECTED for the whole cast: the engine's tool tick only advances while
    /// `who.CurrentTool is FishingRod &amp;&amp; who.UsingTool` (`FishingRod.cs:1910`), so handing the slot back early would
    /// leave a line in the water that nothing drives. `PreviousSlot` is restored on every exit through
    /// <see cref="SettleFishingCast"/>.
    /// </para>
    /// </summary>
    private LocalExecutionReceipt ExecuteFishHere(string executionId, string requestId, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        GameLocation? location = Game1.player.currentLocation;
        if (location is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        if (this.RefuseCastingRig(requestId, executionId) is LocalExecutionReceipt rigRefusal)
            return rigRefusal;
        if (!TrySelectDeclaredTool(Game1.player, "fish_here", out DeclaredToolSelection selection, out string selectionRefusal))
        {
            // Owned but not selectable is the ONE fact `rod_not_equipped` names: `Farmer.CurrentTool` refused to become the
            // rod this pack holds, so nothing could cast it.
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "rod_not_equipped",
                DescribeDeclaredToolRefusal(Game1.player.Items, "fish_here", selectionRefusal));
        }
        if (selection.Tool is not FishingRod rod)
        {
            RestoreToolSelection(Game1.player, selection);
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "rod_not_equipped", $"slot={selection.Slot};tool={selection.Category}");
        }

        LocalExecutionReceipt Refuse(string code, string evidence, RefusalLayerKind layer, string detail) =>
            this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, code,
                $"{evidence};blocked_by={new RefusalLayerToken(layer, detail).Format()}");

        // EVERY exit from here hands the actor's own tool selection back, except the one where the line is in the water:
        // the engine's tool tick only advances while `who.CurrentTool is FishingRod && who.UsingTool`
        // (`FishingRod.cs:1910`), so the rod must stay held until `SettleFishingCast` restores `PreviousSlot`. The flag is
        // what makes that one exception explicit rather than an omission, and `finally` is what makes every refusal keep
        // its promise even if an engine call throws mid-body.
        bool castStarted = false;
        try
        {
            // The engine's own cast gate, asked as the pair `DoFunction` asks before it will set `isFishing`
            // (FishingRod.cs:411), so a cast this file admits is a cast the engine accepts.
            if (!location.canFishHere())
                return Refuse("water_not_fishable:location_cannot_fish", $"location={location.NameOrUniqueName};tile={targetX},{targetY}",
                    RefusalLayerKind.LocationConstraint, "location_cannot_fish");
            if (!location.isWaterTile(targetX, targetY))
                return Refuse("water_not_fishable:not_water", $"location={location.NameOrUniqueName};tile={targetX},{targetY}",
                    RefusalLayerKind.BackTile, "not_water");
            if (!location.isTileFishable(targetX, targetY))
                return Refuse("water_not_fishable:tile_not_fishable", $"location={location.NameOrUniqueName};tile={targetX},{targetY};rod_slot={selection.Slot}",
                    RefusalLayerKind.BackTile, "tile_not_fishable");

            long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (requestedDeadlineMs <= nowMs)
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);

            float staminaBefore = Game1.player.Stamina;
            int baitBefore = rod.GetBait()?.Stack ?? 0;
            // The timing cast's hold-and-release frames are the only part of a cast that reads input, so they are the only
            // part skipped: `beginUsing` runs (it is what records the facing, the last user and the rod's own reset), and
            // then the timing flag is cleared so the engine's tool tick does not replay the hold.
            if (!rod.beginUsing(location, targetX, targetY, Game1.player))
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "rod_not_equipped", $"rod={rod.QualifiedItemId};slot={selection.Slot};begin_using=refused;blocked_by={new RefusalLayerToken(RefusalLayerKind.Tool, "begin_using_refused").Format()}");
            rod.isTimingCast = false;
            // The bobber is the ONE thing a timing cast would have placed: `DoFunction` reads its tile from `bobber` and
            // nothing else (`calculateBobberTile`, `FishingRod.cs:378`), so naming the water tile is naming where the line
            // lands. The centre of a tile is the engine's own coordinate convention (`Game1.tileSize`, `Game1.cs:103`).
            rod.bobber.Set(new Vector2(
                targetX * Game1.tileSize + Game1.tileSize / 2f,
                targetY * Game1.tileSize + Game1.tileSize / 2f));
            // The engine's own cast: it spends the stamina (`FishingRod.cs:407-410`), counts the cast, computes the bite
            // delay (`calculateTimeUntilFishingBite`) and starts the rod's state machine. Nothing here decides any of that.
            rod.DoFunction(location, targetX, targetY, 1, Game1.player);
            if (!rod.isFishing)
            {
                // The engine's own refusal to fish this tile. Reached only if the pair above disagreed with `DoFunction`,
                // which is why it is Uncertain rather than Rejected: the cast may already have spent stamina.
                this.revision++;
                LocalExecutionReceipt notCast = new(executionId, requestId, ExecutionState.Uncertain, "fish_here_cast_not_accepted", this.revision,
                    $"location={location.NameOrUniqueName};target={expectedTargetId};tile={targetX},{targetY};rod={rod.QualifiedItemId};stamina_before={staminaBefore.ToString("0.####", CultureInfo.InvariantCulture)};stamina_after={Game1.player.Stamina.ToString("0.####", CultureInfo.InvariantCulture)}");
                this.Remember(notCast);
                this.AddTrace(notCast);
                this.PublishIdleAfterRelease(executionId, requestId);
                return notCast;
            }

            castStarted = true;
            this.activeFishing = new LocalFishingCastSpec(
                executionId,
                requestId,
                location.NameOrUniqueName,
                targetX,
                targetY,
                expectedTargetId,
                selection.Slot,
                selection.PreviousSlot,
                staminaBefore,
                baitBefore,
                nowMs,
                requestedDeadlineMs,
                LocalFishingPhase.WaitingForBite);
            LocalExecutionReceipt accepted = new(
                executionId,
                requestId,
                ExecutionState.Accepted,
                "accepted",
                this.revision,
                $"location={location.NameOrUniqueName};target={expectedTargetId};tile={targetX},{targetY};rod={rod.QualifiedItemId};rod_slot={selection.Slot};stamina_before={staminaBefore.ToString("0.####", CultureInfo.InvariantCulture)};bait_before={baitBefore};phase=waiting_for_bite");
            this.Remember(accepted);
            this.AddTrace(accepted);
            return accepted;
        }
        finally
        {
            if (!castStarted)
                RestoreToolSelection(Game1.player, selection);
        }
    }

    /// <summary>
    /// One tick of an active cast. The rod's own state machine (bite timer, nibble window, the catch window it opens) is
    /// driven by the engine's tool tick (`FishingRod.tickUpdate`, called for every tool in the pack by
    /// `Farmer.cs:7897-7903`); this pass only acts on the states the engine reports, and never on a clock of its own.
    /// </summary>
    private void UpdateFishingCast()
    {
        if (this.activeFishing is not { } spec) return;
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        GameLocation? location = Game1.player.currentLocation;
        if (location is null || !string.Equals(location.NameOrUniqueName, spec.Location, StringComparison.Ordinal)
            || Game1.player.CurrentTool is not FishingRod rod)
        {
            this.SettleFishingCast(spec, ExecutionState.Uncertain, "fish_here_cast_interrupted",
                $"location={spec.Location};target={spec.TargetId};tile={spec.TargetX},{spec.TargetY};actual_location={location?.NameOrUniqueName ?? "none"};phase={spec.Phase}");
            return;
        }

        switch (spec.Phase)
        {
            case LocalFishingPhase.WaitingForBite:
            {
                if (rod.isNibbling && !rod.hit)
                {
                    // The engine's own hook. A player's click lands here, and so does the AutoHook enchantment
                    // (`FishingRod.cs:2130-2137`): `DoFunction` while `isNibbling` is what picks the fish out of the engine's
                    // own tables and opens the catch window. Nothing about the fish is read or chosen here.
                    rod.DoFunction(location, spec.TargetX, spec.TargetY, 1, Game1.player);
                    this.activeFishing = spec with { Phase = LocalFishingPhase.AwaitingCatchWindow };
                    return;
                }
                if (nowMs > spec.DeadlineMs)
                {
                    // The WORLD never bit inside this action's own budget. It is not a lost fish and it consumes nothing
                    // beyond the cast: the rod is reeled in with the engine's own stop, which spends no bait or tackle.
                    this.SettleFishingCast(spec, ExecutionState.Expired, "fish_here_bite_deadline_expired",
                        $"location={spec.Location};target={spec.TargetId};tile={spec.TargetX},{spec.TargetY};waited_ms={(nowMs - spec.StartedAtMs).ToString(CultureInfo.InvariantCulture)};nibbling=false;phase=waiting_for_bite");
                }
                return;
            }

            case LocalFishingPhase.AwaitingCatchWindow:
            {
                if (Game1.activeClickableMenu is BobberBar bar && !string.IsNullOrWhiteSpace(bar.whichFish))
                {
                    // The engine built this bar for THIS catch (`FishingRod.startMinigameEndFunction`, `:891-940`), which is
                    // where the size and the quality are decided from `Data/Fish` and its own roll, and where the difficulty
                    // comes from. Reading them here is what keeps this file free of a second copy of any of those rules.
                    string fishId = bar.whichFish;
                    int countBefore = Game1.player.fishCaught.TryGetValue(fishId, out int[]? caughtBefore) ? caughtBefore[0] : 0;
                    // The bar's own challenge-bait count is part of the same object; `numCaught` is 1 otherwise
                    // (`BobberBar.cs:353-358`).
                    int numCaught = Math.Max(1, bar.challengeBaitFishes);
                    // The win path's own line (`BobberBar.cs:368`): the minigame is closed by the same call the game closes it
                    // with, and the bar never runs an update frame - it is cleared in the tick that observed it.
                    Game1.exitActiveMenu();
                    // `wasPerfect: true` is a DECLARED PROPERTY OF THIS ACTION, not an observation: the bar starts `perfect`
                    // true and only the minigame's own bar can clear it (`BobberBar.cs:185`), and this action does not play
                    // the bar. A catch made here is perfect by construction, and the receipt says so in those words.
                    rod.pullFishFromWater(fishId, bar.fishSize, bar.fishQuality, (int)bar.difficulty, bar.treasureCaught,
                        wasPerfect: true, fromFishPond: bar.fromFishPond, bar.setFlagOnCatch, bar.bossFish, numCaught);
                    this.activeFishing = spec with
                    {
                        Phase = LocalFishingPhase.AwaitingCredit,
                        CaughtQualifiedItemId = fishId,
                        CaughtFishSize = bar.fishSize,
                        CaughtFishQuality = bar.fishQuality,
                        CaughtCountBefore = countBefore,
                    };
                    return;
                }
                if (nowMs > spec.DeadlineMs)
                    this.SettleFishingCast(spec, ExecutionState.Expired, "fish_here_catch_window_deadline_expired",
                        $"location={spec.Location};target={spec.TargetId};tile={spec.TargetX},{spec.TargetY};phase=awaiting_catch_window");
                return;
            }

            case LocalFishingPhase.AwaitingCredit:
            {
                // `fishCaught` is the rod's own "the fish is in hand" flag and nothing but `playerCaughtFishEndFunction`
                // sets it (`FishingRod.cs:1092`), i.e. it is true exactly when the engine has booked the catch.
                if (!rod.fishCaught)
                {
                    if (nowMs > spec.DeadlineMs)
                        this.SettleFishingCast(spec, ExecutionState.Uncertain, "fish_here_catch_not_credited",
                            $"location={spec.Location};target={spec.TargetId};fish={spec.CaughtQualifiedItemId ?? "none"};phase=awaiting_credit;fish_in_hand=false");
                    return;
                }
                string fishQualifiedItemId = spec.CaughtQualifiedItemId ?? rod.whichFish?.QualifiedItemId ?? string.Empty;
                int inventoryBefore = CountQualifiedItem(Game1.player, fishQualifiedItemId);
                // The engine's own win settle (`FishingRod.cs:2304-2350`): it adds the fish to the pack and calls
                // `doneFishing(who, consumeBaitAndTackle: true)` - the bait and tackle consumption the card asks for, from
                // the one place the game performs it. A player reaches it by clicking the held fish (`:2273-2275`).
                rod.doneHoldingFish(Game1.player);
                int inventoryAfter = CountQualifiedItem(Game1.player, fishQualifiedItemId);
                int caughtAfter = Game1.player.fishCaught.TryGetValue(fishQualifiedItemId, out int[]? caughtAfterEntry) ? caughtAfterEntry[0] : 0;
                bool credited = caughtAfter > spec.CaughtCountBefore;
                float staminaAfter = Game1.player.Stamina;
                float staminaDelta = staminaAfter - spec.StaminaBefore;
                int baitAfter = rod.GetBait()?.Stack ?? 0;
                string evidence = string.Format(
                    CultureInfo.InvariantCulture,
                    "location={0};target={1};tile={2},{3};caught_qualified_item_id={4};display_name={5};fish_size={6};quality={7};was_perfect=true;was_perfect_basis=declared_by_action;rod_durability_left={8};bait_before={9};bait_left={10};stamina_before={11};stamina_after={12};stamina_delta={13};inventory_before={14};inventory_after={15};fish_caught_before={16};fish_caught_after={17}",
                    spec.Location,
                    spec.TargetId,
                    spec.TargetX,
                    spec.TargetY,
                    fishQualifiedItemId,
                    RequireDisplayName(fishQualifiedItemId),
                    spec.CaughtFishSize,
                    spec.CaughtFishQuality,
                    DescribeTackleUsesLeft(rod),
                    spec.BaitBefore,
                    baitAfter,
                    spec.StaminaBefore.ToString("0.####", CultureInfo.InvariantCulture),
                    staminaAfter.ToString("0.####", CultureInfo.InvariantCulture),
                    staminaDelta.ToString("0.####", CultureInfo.InvariantCulture),
                    inventoryBefore,
                    inventoryAfter,
                    spec.CaughtCountBefore,
                    caughtAfter);
                this.SettleFishingCast(
                    spec,
                    credited ? ExecutionState.Succeeded : ExecutionState.Uncertain,
                    credited ? "fish_caught" : "fish_here_catch_not_credited",
                    evidence);
                return;
            }
        }
    }

    /// <summary>
    /// The rod's remaining durability, which IS its tackle's remaining uses: `FishingRod.doDoneFishing` increments
    /// `Object.uses` per equipped tackle and drops it at `maxTackleUses` (`FishingRod.cs:1765-1782`). A rod with no tackle
    /// has no durability to report, and `-1` is published rather than a zero that would read as "worn out".
    /// </summary>
    private static int DescribeTackleUsesLeft(FishingRod rod)
    {
        int left = -1;
        foreach (StardewValley.Object tackle in rod.GetTackle())
        {
            if (tackle is null) continue;
            int remaining = FishingRod.maxTackleUses - tackle.uses.Value;
            left = left < 0 ? remaining : Math.Min(left, remaining);
        }
        return left;
    }

    /// <summary>
    /// The ONE exit for an active cast: hand the actor's own tool selection back, reel the engine's rod in when it is still
    /// in use (the engine's own stop, which spends no bait and no tackle), then mint the terminal.
    /// </summary>
    private void SettleFishingCast(LocalFishingCastSpec spec, ExecutionState state, string reasonCode, string evidence)
    {
        this.activeFishing = null;
        if (spec.PreviousSlot >= 0 && spec.PreviousSlot < Game1.player.Items.Count)
            Game1.player.CurrentToolIndex = spec.PreviousSlot;
        // A cast that never reached the engine's win path is reeled in with `doneFishing(who)` - the overload that consumes
        // nothing - so the rod is not left holding a line nobody drives after the action has ended.
        if (spec.Phase != LocalFishingPhase.AwaitingCredit
            && spec.RodSlot >= 0 && spec.RodSlot < Game1.player.Items.Count
            && Game1.player.Items[spec.RodSlot] is FishingRod rod && rod.inUse())
            rod.doneFishing(Game1.player);
        // The catch window the engine opened may still be on screen if the action ended between the bite and the win.
        if (Game1.activeClickableMenu is BobberBar) Game1.exitActiveMenu();
        this.revision++;
        LocalExecutionReceipt receipt = new(spec.ExecutionId, spec.RequestId, state, reasonCode, this.revision, evidence);
        this.Remember(receipt);
        this.AddTrace(receipt);
        this.PublishIdleAfterRelease(spec.ExecutionId, spec.RequestId);
    }
}
