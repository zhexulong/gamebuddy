using System.Globalization;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Tools;
using StardewValley.Characters;
using GameBuddy.Stardew.Core;

namespace GameBuddy.Stardew;

internal sealed partial class ExecutionManager
{
    private static bool IsTileWithinToolReach(Farmer player, int targetX, int targetY) =>
        IsTileWithinChebyshevRadius(player, targetX, targetY, 1) && !IsToolTargetUnderActor(player, targetX, targetY);

    public LocalExecutionReceipt RequestLocalChopTreeSource(string requestId, int slot, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs) =>
        this.RequestLocalTileTarget(
            "chop_tree", requestId, targetX, targetY, expectedTargetId, requestedDeadlineMs,
            AdmissionActionabilityProfile.General,
            authorize: null,
            gate: location =>
            {
                if (ResolveDeclaredTool(Game1.player.Items, "chop_tree").RefusalCode is { } toolRefusal)
                    return new TileTargetRefusal(toolRefusal, DescribeDeclaredToolRefusal(Game1.player.Items, "chop_tree", toolRefusal, slot));
                return DescribeTreeChopSourceRefusal(location, targetX, targetY, expectedTargetId);
            },
            inReach: IsTileWithinToolReach,
            execute: (executionId, admittedRequestId) => this.ExecuteChopTree(executionId, admittedRequestId, slot, targetX, targetY, expectedTargetId));

    /// <summary>
    /// MOSS IS NOT A REFUSAL. `Tree.performToolAction` strips it on the way through - it drops the moss item, sets
    /// `hasMoss = false` and keeps going into the axe branch in the SAME swing (Tree.cs:1087-1120) - so a mossy tree is a
    /// tree the axe fells. Refusing it here was a second, narrower answer than the engine's.
    /// </summary>
    private static TileTargetRefusal? DescribeTreeChopSourceRefusal(GameLocation location, int targetX, int targetY, string expectedTargetId) =>
        location.terrainFeatures.TryGetValue(new Vector2(targetX, targetY), out StardewValley.TerrainFeatures.TerrainFeature? feature)
            && feature is StardewValley.TerrainFeatures.Tree tree
            && !tree.stump.Value
            && tree.growthStage.Value >= StardewValley.TerrainFeatures.Tree.treeStage
            && !tree.tapped.Value
            && tree.health.Value > 0f
            && string.Equals(BuildTreeChopSourceTargetId(location, targetX, targetY, tree), expectedTargetId, StringComparison.Ordinal)
                ? null
                : new TileTargetRefusal("tree_chop_target_changed", $"target={targetX},{targetY}");

    /// <summary>
    /// Executes chop_tree_source against the current world, re-validating the tool
    /// and the target first because an approach leg may have taken several ticks and
    /// either can have changed while walking. Terminal receipts are minted here so
    /// the in-range path and the post-approach path share one execution body.
    ///
    /// <para>
    /// ONE REQUEST FELLS THE TREE. `Axe.DoFunction` swings once (Axe.cs:63-97) and `Tree.performToolAction` removes
    /// `upgradeLevel switch { 0 => 1f, ... }` from `health` (Tree.cs:1177-1200), so a mature tree needs ten basic-axe
    /// hits - and a one-swing action therefore cost one plan node, one engine round trip and one model decision per
    /// hit. This body keeps swinging the same selected axe at the same tile until the engine marks the tree felled,
    /// which is the shape `break_resource_clump` already uses for a clump and `chop_stump` for a stump. The stump is
    /// left standing on purpose: a felled tree and a cleared stump are different terminal states and `chop_stump`
    /// owns the second one.
    /// </para>
    /// </summary>
    private LocalExecutionReceipt ExecuteChopTree(string executionId, string requestId, int slot, int targetX, int targetY, string expectedTargetId)
    {
        if (!TrySelectDeclaredTool(Game1.player, "chop_tree", out DeclaredToolSelection selection, out string toolRefusalCode))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, toolRefusalCode, DescribeDeclaredToolRefusal(Game1.player.Items, "chop_tree", toolRefusalCode, slot));
        ExecutionState state;
        string reasonCode;
        string evidence;
        try
        {
            if (selection.Tool is not Axe axe)
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, $"tool_not_selected:{selection.Category}", $"slot={selection.Slot}");
            GameLocation location = Game1.player.currentLocation;
            Vector2 tile = new(targetX, targetY);
            if (!location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? feature) || feature is not StardewValley.TerrainFeatures.Tree tree
                || tree.stump.Value || tree.growthStage.Value < StardewValley.TerrainFeatures.Tree.treeStage || tree.tapped.Value || tree.health.Value <= 0f
                || !string.Equals(BuildTreeChopSourceTargetId(location, targetX, targetY, tree), expectedTargetId, StringComparison.Ordinal))
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "tree_chop_target_changed", $"target={targetX},{targetY}");
            float before = tree.health.Value;
            bool stumpBefore = tree.stump.Value;
            string treeType = tree.treeType.Value;
            // HOW MANY HITS THE LOOP IS WILLING TO SPEND. `Tree.performToolAction` removes at least one point per swing
            // (`upgradeLevel switch { 0 => 1f, 1 => 1.25f, ... }`, Tree.cs:1177-1200), so the ceiling of the remaining
            // health is the worst case this tree can need at any axe tier and the +4 is the same headroom
            // `break_resource_clump` carries for fractional health. It is a bound on ONE request's swings, not a budget
            // on the action: a target the axe cannot finish ends in a named stop instead of a loop.
            int swingsWorstCase = Math.Max(1, (int)Math.Ceiling(before));
            int swingCap = swingsWorstCase + 4;
            // The stamina red line, priced against the worst case the loop may spend. The engine does not refuse a
            // swing for lack of stamina; it lets it run negative and then faints the actor (Game1.cs:6452), which
            // halves next day's stamina and ends a multi-day routine. Same guard and refusal code as `chop_stump`.
            ToolStaminaVerdict stamina = ToolStaminaGuard.Check(
                Game1.player.Stamina,
                ToolStaminaGuard.EstimatedCost(swingsWorstCase, Game1.player.ForagingLevel, axe.IsEfficient));
            if (!stamina.Allowed)
                return this.RememberTerminal(
                    requestId,
                    executionId,
                    ExecutionState.Rejected,
                    stamina.ReasonCode,
                    $"target={expectedTargetId};tree_type={treeType};swings_worst_case={swingsWorstCase};{stamina.Evidence}");

            float staminaBefore = Game1.player.Stamina;
            int swingCount = 0;
            float lastHealth = before;
            string? stoppedBy = null;
            string stopEvidence = string.Empty;
            while (swingCount < swingCap)
            {
                if (!location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? standing) || !ReferenceEquals(standing, tree))
                {
                    stoppedBy = "tree_changed_during_swings";
                    stopEvidence = $"tree_at_tile={(standing is null ? "none" : standing.GetType().Name)}";
                    break;
                }
                if (tree.stump.Value)
                    break;
                if (Game1.player.CurrentTool is not Axe held || !ReferenceEquals(held, axe))
                {
                    stoppedBy = "tool_no_longer_satisfies";
                    stopEvidence = $"held={DescribeToolCategory(Game1.player.CurrentTool) ?? "none"}";
                    break;
                }
                if (Game1.player.Stamina <= WorldModel.PassOutStaminaFloor)
                {
                    stoppedBy = $"stamina_exhausted_after_{swingCount.ToString(CultureInfo.InvariantCulture)}_swings";
                    stopEvidence = $"stamina={Game1.player.Stamina.ToString("0.####", CultureInfo.InvariantCulture)};floor={WorldModel.PassOutStaminaFloor.ToString("0.####", CultureInfo.InvariantCulture)}";
                    break;
                }
                if (swingCount > 0 && tree.health.Value >= lastHealth)
                {
                    stoppedBy = "tool_no_longer_satisfies";
                    stopEvidence = $"health_before_swing={lastHealth.ToString("0.##", CultureInfo.InvariantCulture)};health_after_swing={tree.health.Value.ToString("0.##", CultureInfo.InvariantCulture)}";
                    break;
                }
                lastHealth = tree.health.Value;
                UseNativeToolOnTile(axe, location, targetX, targetY, Game1.player, staminaBefore);
                swingCount++;
            }

            float staminaAfter = Game1.player.Stamina;
            float staminaDelta = staminaAfter - staminaBefore;
            float perSwingStaminaCost = ToolStaminaGuard.PerSwingCharge(Game1.player.ForagingLevel, axe.IsEfficient);
            // THE POSTCONDITION IS THE WORLD, not the loop's counter: read the tile again after the swings. `Axe.DoFunction`
            // returns nothing useful about the tree, and on the swing that reaches `<= 0` the engine sets
            // `stump = true; health = 5f; falling = true` and returns FALSE (Tree.cs:1489-1497) - so the felled stump is
            // the terminal state, and a tree that is merely damaged is NOT a completed chop.
            bool sameTree = location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? afterFeature) && ReferenceEquals(afterFeature, tree);
            float after = sameTree ? tree.health.Value : float.NaN;
            bool stumpAfter = sameTree && tree.stump.Value;
            bool felled = !stumpBefore && stumpAfter;
            string healthAfterText = float.IsFinite(after) ? after.ToString("0.##", CultureInfo.InvariantCulture) : "missing";
            evidence = $"target={expectedTargetId};tool=axe;tree={treeType};health_before={before.ToString("0.##", CultureInfo.InvariantCulture)};health_after={healthAfterText};stump_before={stumpBefore.ToString().ToLowerInvariant()};stump_after={stumpAfter.ToString().ToLowerInvariant()};source_transformed={felled.ToString().ToLowerInvariant()};swings={swingCount.ToString(CultureInfo.InvariantCulture)};stamina_before={staminaBefore.ToString("0.####", CultureInfo.InvariantCulture)};stamina_after={staminaAfter.ToString("0.####", CultureInfo.InvariantCulture)};stamina_delta={staminaDelta.ToString("0.####", CultureInfo.InvariantCulture)};expected_stamina_cost={(perSwingStaminaCost * swingCount).ToString("0.####", CultureInfo.InvariantCulture)}";
            if (stoppedBy is not null)
                evidence += $";stopped_by={stoppedBy};{stopEvidence}";
            (state, reasonCode) = PostconditionVerdict(felled, "tree_source_chopped", stoppedBy ?? "tree_source_chop_postcondition_unavailable");
        }
        finally
        {
            RestoreToolSelection(Game1.player, selection);
        }
        evidence += $";{SelectionSuffix(selection)}";
        return this.RememberTerminal(requestId, executionId, state, reasonCode, evidence);
    }

    public LocalExecutionReceipt RequestLocalBreakRockSource(string requestId, int slot, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs) =>
        this.RequestLocalTileTarget(
            "break_rock", requestId, targetX, targetY, expectedTargetId, requestedDeadlineMs,
            AdmissionActionabilityProfile.General,
            authorize: null,
            gate: location =>
            {
                if (ResolveDeclaredTool(Game1.player.Items, "break_rock").RefusalCode is { } toolRefusal)
                    return new TileTargetRefusal(toolRefusal, $"slot={slot}");
                return DescribeRockSourceRefusal(location, targetX, targetY, expectedTargetId);
            },
            inReach: IsTileWithinToolReach,
            execute: (executionId, admittedRequestId) => this.ExecuteBreakRock(executionId, admittedRequestId, slot, targetX, targetY, expectedTargetId));

    private static TileTargetRefusal? DescribeRockSourceRefusal(GameLocation location, int targetX, int targetY, string expectedTargetId) =>
        location.objects.TryGetValue(new Vector2(targetX, targetY), out StardewValley.Object? rock)
            && NativeItemPredicates.IsBreakableStone(rock)
            && string.Equals(BuildRockSourceTargetId(location, targetX, targetY, rock), expectedTargetId, StringComparison.Ordinal)
                ? null
                : new TileTargetRefusal("rock_target_changed", $"target={targetX},{targetY}");

    private LocalExecutionReceipt ExecuteBreakRock(string executionId, string requestId, int slot, int targetX, int targetY, string expectedTargetId)
    {
        if (!TrySelectDeclaredTool(Game1.player, "break_rock", out DeclaredToolSelection selection, out string toolRefusalCode))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, toolRefusalCode, $"slot={slot}");
        Dictionary<string, string> evidence = ToolActionEvidence.SelectionFacts(selection);
        ExecutionState state;
        string reasonCode;
        try
        {
            if (selection.Tool is not Pickaxe pickaxe)
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, $"tool_not_selected:{selection.Category}", $"slot={selection.Slot}");
            GameLocation location = Game1.player.currentLocation;
            Vector2 tile = new(targetX, targetY);
            if (!location.objects.TryGetValue(tile, out StardewValley.Object? rock) || !NativeItemPredicates.IsBreakableStone(rock) || !string.Equals(BuildRockSourceTargetId(location, targetX, targetY, rock), expectedTargetId, StringComparison.Ordinal)) return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "rock_target_changed", $"target={targetX},{targetY}");
            int before = rock.MinutesUntilReady;
            float staminaBefore = Game1.player.Stamina;
            UseNativeToolOnTile(pickaxe, location, targetX, targetY, Game1.player, staminaBefore);
            float staminaAfter = Game1.player.Stamina;
            float staminaDelta = staminaAfter - staminaBefore;
            // Pickaxe covers power with who.toolPower.Value before deducting; a plain
            // tap holds toolPower at 0 (pressUseToolButton resets it), so a basic
            // pickaxe tap costs 2*(0+1) - Mining*0.1 = 2 - Mining*0.1.
            float expectedStaminaCost = pickaxe.IsEfficient ? 0f : 2f - (Game1.player.MiningLevel * 0.1f);
            bool removed = !location.objects.TryGetValue(tile, out StardewValley.Object? afterRock);
            int? after = removed ? null : afterRock!.MinutesUntilReady;
            evidence["target"] = expectedTargetId;
            evidence["tool"] = "pickaxe";
            evidence["qualified_item_id"] = rock.QualifiedItemId;
            evidence["durability_before"] = before.ToString(CultureInfo.InvariantCulture);
            evidence["durability_after"] = removed ? "removed" : afterRock!.MinutesUntilReady.ToString(CultureInfo.InvariantCulture);
            evidence["removed"] = removed.ToString().ToLowerInvariant();
            evidence["stamina_before"] = staminaBefore.ToString("0.####", CultureInfo.InvariantCulture);
            evidence["stamina_after"] = staminaAfter.ToString("0.####", CultureInfo.InvariantCulture);
            evidence["stamina_delta"] = staminaDelta.ToString("0.####", CultureInfo.InvariantCulture);
            evidence["expected_stamina_cost"] = expectedStaminaCost.ToString("0.####", CultureInfo.InvariantCulture);
            // ONE SWING, TWO LEGAL OUTCOMES, and neither of them is "the rock is gone".
            //
            // `break_rock_source` spends exactly one `Pickaxe.DoFunction`, which subtracts
            // `Math.Max(1, upgradeLevel + 1) + additionalPower` from `MinutesUntilReady` (Pickaxe.cs:139-140) and
            // RETURNS EARLY while the remainder is positive (Pickaxe.cs:142-146) - so a damaged rock is the ordinary
            // outcome of every swing but the last, at every upgrade level, on every mine node. Only the stone whose
            // durability reaches zero leaves the object layer (Pickaxe.cs:169-178).
            //
            // Requiring removal encoded the one-swing rock: `Uncertain` for every mine node, because the predicate that
            // admitted the target in the first place had already required durability 1. That is the same defect the
            // tree path carried (1786682c), and it is repaired the same way - one dispatch is one swing, and the plan
            // decides whether to swing again.
            bool succeeded = RockSourceSwing.MadeProgress(before, after);
            (state, reasonCode) = PostconditionVerdict(succeeded, removed ? "rock_source_broken" : "rock_source_damaged", "rock_source_postcondition_unavailable");
        }
        finally
        {
            RestoreToolSelection(Game1.player, selection);
            evidence["tool_restored"] = DescribeToolCategory(Game1.player.CurrentTool);
        }
        return this.RememberTerminal(requestId, executionId, state, reasonCode, ToolActionEvidence.Compose(ToolActionEvidence.BreakRockSource, evidence));
    }

    /// <summary>One native Basic Pickaxe use removes exactly one fresh adjacent empty ground HoeDirt; crops, IndoorPots, drops, and collection are outside this action.</summary>
    public LocalExecutionReceipt RequestLocalDigArtifactSpot(string requestId, int slot, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.InvalidateArtifactSpotResult();
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.Physical) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;
        if (ResolveDeclaredTool(Game1.player.Items, "dig_artifact_spot").RefusalCode is { } toolRefusal)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, toolRefusal, DescribeDeclaredToolRefusal(Game1.player.Items, "dig_artifact_spot", toolRefusal, slot));
        GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.isTileOnMap(tile)
            || !location.objects.TryGetValue(tile, out StardewValley.Object? probeSpot)
            || !NativeItemPredicates.IsArtifactSpot(probeSpot)
            || !string.Equals(BuildArtifactSpotTargetId(location, targetX, targetY, probeSpot.QualifiedItemId), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "artifact_spot_target_changed", $"target={targetX},{targetY}");
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1) || IsToolTargetUnderActor(Game1.player, targetX, targetY))
        {
            return this.TryBeginToolApproach(
                requestId,
                executionId,
                "dig_artifact_spot",
                location,
                targetX,
                targetY,
                expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteDigArtifactSpot(arrivalExecutionId, arrivalRequestId, slot, targetX, targetY, expectedTargetId),
                nowMs,
                requestedDeadlineMs);
        }

        return this.ExecuteDigArtifactSpot(executionId, requestId, slot, targetX, targetY, expectedTargetId);
    }

    private LocalExecutionReceipt ExecuteDigArtifactSpot(string executionId, string requestId, int slot, int targetX, int targetY, string expectedTargetId)
    {
        if (!TrySelectDeclaredTool(Game1.player, "dig_artifact_spot", out DeclaredToolSelection selection, out string toolRefusalCode))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, toolRefusalCode, DescribeDeclaredToolRefusal(Game1.player.Items, "dig_artifact_spot", toolRefusalCode, slot));
        ExecutionState state;
        string reasonCode;
        string evidence;
        try
        {
            if (selection.Tool is not Hoe hoe)
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, $"tool_not_selected:{selection.Category}", $"slot={selection.Slot}");
            GameLocation location = Game1.player.currentLocation;
            Vector2 tile = new(targetX, targetY);
            if (!location.isTileOnMap(tile)
                || !location.objects.TryGetValue(tile, out StardewValley.Object? artifactSpot)
                || !NativeItemPredicates.IsArtifactSpot(artifactSpot)
                || !string.Equals(BuildArtifactSpotTargetId(location, targetX, targetY, artifactSpot.QualifiedItemId), expectedTargetId, StringComparison.Ordinal))
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "artifact_spot_target_changed", $"target={targetX},{targetY}");
            bool sourcePresentBefore = true;
            bool hoeDirtPresentBefore = location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? beforeFeature) && beforeFeature is StardewValley.TerrainFeatures.HoeDirt;
            if (hoeDirtPresentBefore)
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "artifact_spot_hoedirt_present_before", $"target={targetX},{targetY};hoedirt_present_before=true");
            float staminaBefore = Game1.player.Stamina;
            UseNativeToolOnTile(hoe, location, targetX, targetY, Game1.player, staminaBefore);
            float staminaAfter = Game1.player.Stamina;
            float staminaDelta = staminaAfter - staminaBefore;
            float expectedStaminaCost = hoe.IsEfficient ? 0f : 2f - (Game1.player.FarmingLevel * 0.1f);
            bool sourcePresentAfter = location.objects.TryGetValue(tile, out _);
            bool hoeDirtPresentAfter = location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? afterFeature)
                && afterFeature is StardewValley.TerrainFeatures.HoeDirt afterDirt
                && afterDirt.crop is null
                && !(location.objects.TryGetValue(tile, out StardewValley.Object? placedAfter) && placedAfter is StardewValley.Objects.IndoorPot);
            bool succeeded = !hoeDirtPresentBefore && !sourcePresentAfter && hoeDirtPresentAfter;
            string? resultTargetId = succeeded ? BuildArtifactSpotResultTargetId(location, targetX, targetY) : null;
            if (succeeded)
            {
                this.artifactSpotResultTarget = new BridgeArtifactSpotResultTarget(resultTargetId!, location.NameOrUniqueName, targetX, targetY, Crop: false, Ground: true);
                this.artifactSpotResultExecutionId = executionId;
                this.artifactSpotResultRequestId = requestId;
                this.artifactSpotResultRevision = this.revision;
                this.artifactSpotResultDay = Game1.Date.TotalDays;
            }
            evidence = $"location={location.NameOrUniqueName};target={expectedTargetId};result_target={resultTargetId ?? "none"};tile={targetX},{targetY};tool=hoe;stamina_before={staminaBefore.ToString("0.####", CultureInfo.InvariantCulture)};stamina_after={staminaAfter.ToString("0.####", CultureInfo.InvariantCulture)};stamina_delta={staminaDelta.ToString("0.####", CultureInfo.InvariantCulture)};expected_stamina_cost={expectedStaminaCost.ToString("0.####", CultureInfo.InvariantCulture)};qualified_item_id={artifactSpot.QualifiedItemId};source_present_before={sourcePresentBefore.ToString().ToLowerInvariant()};source_present_after={sourcePresentAfter.ToString().ToLowerInvariant()};hoedirt_present_before={hoeDirtPresentBefore.ToString().ToLowerInvariant()};hoedirt_present_after={hoeDirtPresentAfter.ToString().ToLowerInvariant()};source_removed={(!sourcePresentAfter).ToString().ToLowerInvariant()}";
            (state, reasonCode) = PostconditionVerdict(succeeded, "artifact_spot_dug", "artifact_spot_postcondition_unavailable");
        }
        finally
        {
            RestoreToolSelection(Game1.player, selection);
        }
        evidence += $";{SelectionSuffix(selection)}";
        return this.RememberTerminal(requestId, executionId, state, reasonCode, evidence);
    }

    public LocalExecutionReceipt RequestLocalClearHoeDirt(string requestId, int slot, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs) =>
        this.RequestLocalTileTarget(
            "clear_hoedirt", requestId, targetX, targetY, expectedTargetId, requestedDeadlineMs,
            AdmissionActionabilityProfile.General,
            authorize: null,
            gate: location =>
            {
                if (ResolveDeclaredTool(Game1.player.Items, "clear_hoedirt").RefusalCode is { } toolRefusal)
                    return new TileTargetRefusal(toolRefusal, DescribeDeclaredToolRefusal(Game1.player.Items, "clear_hoedirt", toolRefusal, slot));
                return DescribeClearHoeDirtRefusal(location, targetX, targetY, expectedTargetId);
            },
            inReach: IsTileWithinToolReach,
            execute: (executionId, admittedRequestId) => this.ExecuteClearHoedirt(executionId, admittedRequestId, slot, targetX, targetY, expectedTargetId));

    private static TileTargetRefusal? DescribeClearHoeDirtRefusal(GameLocation location, int targetX, int targetY, string expectedTargetId) =>
        location.terrainFeatures.TryGetValue(new Vector2(targetX, targetY), out StardewValley.TerrainFeatures.TerrainFeature? feature)
            && feature is StardewValley.TerrainFeatures.HoeDirt dirt
            && dirt.crop is null
            && !(location.objects.TryGetValue(new Vector2(targetX, targetY), out StardewValley.Object? placed) && placed is StardewValley.Objects.IndoorPot)
            && string.Equals(BuildClearHoeDirtTargetId(location, targetX, targetY), expectedTargetId, StringComparison.Ordinal)
                ? null
                : new TileTargetRefusal("clear_hoedirt_target_changed", $"target={targetX},{targetY}");

    private LocalExecutionReceipt ExecuteClearHoedirt(string executionId, string requestId, int slot, int targetX, int targetY, string expectedTargetId)
    {
        if (!TrySelectDeclaredTool(Game1.player, "clear_hoedirt", out DeclaredToolSelection selection, out string toolRefusalCode))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, toolRefusalCode, DescribeDeclaredToolRefusal(Game1.player.Items, "clear_hoedirt", toolRefusalCode, slot));
        ExecutionState state;
        string reasonCode;
        string evidence;
        try
        {
            if (selection.Tool is not Pickaxe pickaxe)
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, $"tool_not_selected:{selection.Category}", $"slot={selection.Slot}");
            GameLocation location = Game1.player.currentLocation;
            Vector2 tile = new(targetX, targetY);
            if (!location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? feature) || feature is not StardewValley.TerrainFeatures.HoeDirt dirt || dirt.crop is not null || (location.objects.TryGetValue(tile, out StardewValley.Object? placed) && placed is StardewValley.Objects.IndoorPot) || !string.Equals(BuildClearHoeDirtTargetId(location, targetX, targetY), expectedTargetId, StringComparison.Ordinal)) return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "clear_hoedirt_target_changed", $"target={targetX},{targetY}");
            float staminaBefore = Game1.player.Stamina;
            UseNativeToolOnTile(pickaxe, location, targetX, targetY, Game1.player, staminaBefore);
            float staminaAfter = Game1.player.Stamina;
            float staminaDelta = staminaAfter - staminaBefore;
            // Pickaxe covers power with toolPower.Value (tap => 0), so a basic
            // pickaxe tap costs 2*(0+1) - Mining*0.1 = 2 - Mining*0.1.
            float expectedStaminaCost = pickaxe.IsEfficient ? 0f : 2f - (Game1.player.MiningLevel * 0.1f);
            bool hoeDirtPresentAfter = location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? afterFeature) && afterFeature is StardewValley.TerrainFeatures.HoeDirt;
            bool removed = !hoeDirtPresentAfter;
            evidence = $"location={location.NameOrUniqueName};target={expectedTargetId};tile={targetX},{targetY};tool=pickaxe;crop_before=false;hoedirt_present_before=true;hoedirt_present_after={hoeDirtPresentAfter.ToString().ToLowerInvariant()};removed={removed.ToString().ToLowerInvariant()};stamina_before={staminaBefore.ToString("0.####", CultureInfo.InvariantCulture)};stamina_after={staminaAfter.ToString("0.####", CultureInfo.InvariantCulture)};stamina_delta={staminaDelta.ToString("0.####", CultureInfo.InvariantCulture)};expected_stamina_cost={expectedStaminaCost.ToString("0.####", CultureInfo.InvariantCulture)}";
            (state, reasonCode) = PostconditionVerdict(removed, "hoedirt_cleared", "clear_hoedirt_postcondition_unavailable");
        }
        finally
        {
            RestoreToolSelection(Game1.player, selection);
        }
        evidence += $";{SelectionSuffix(selection)}";
        return this.RememberTerminal(requestId, executionId, state, reasonCode, evidence);
    }

    public LocalExecutionReceipt RequestLocalTillSoil(string requestId, int targetX, int targetY, int charge, long requestedDeadlineMs)
    {
        if (this.BeginLocalExecution(requestId, out string executionId, out long nowMs) is LocalExecutionReceipt replay) return replay;
        if (!this.TryGetBoundActor(out Farmer? boundActor, out string scopeReason) || boundActor is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, scopeReason, null);

        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        // Shared mechanical admission (identity → actionability → deadline →
        // body exclusivity) in the one authority, in that same order: the
        // refusal now NAMES the hold (actor_held_by_modal / cutscene_active /
        // actor_passed_out / transient_busy) where the three split guards
        // reported player_menu_open / player_event_active / player_cannot_move.
        // Geometry, target identity and the postcondition stay action-specific.
        // Physical: tilling drives the Hoe.
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.Physical) is { } admissionRefusal)
            return admissionRefusal;
        if (ResolveDeclaredTool(Game1.player.Items, "till_soil").RefusalCode is { } toolRefusal)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, toolRefusal, DescribeDeclaredToolRefusal(Game1.player.Items, "till_soil", toolRefusal));
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1) || IsToolTargetUnderActor(Game1.player, targetX, targetY))
        {
            StardewValley.GameLocation distantLocation = Game1.player.currentLocation;
            if (DescribeSoilRefusal(distantLocation, targetX, targetY) is { } soilRefusal)
            {
                return this.RememberTerminal(
                    requestId,
                    executionId,
                    ExecutionState.Rejected,
                    DescribeSoilRefusalCode(soilRefusal),
                    $"target={targetX},{targetY}{DescribeSoilGuidance(distantLocation, targetX, targetY)}");
            }

            return this.TryBeginToolApproach(
                requestId,
                executionId,
                "till_soil",
                distantLocation,
                targetX,
                targetY,
                $"till_soil_{targetX}_{targetY}",
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteTillSoil(arrivalExecutionId, arrivalRequestId, targetX, targetY, charge, requestedDeadlineMs),
                nowMs,
                requestedDeadlineMs,
                noStandingTileCodePrefix: NoStandingTileCodePrefix);
        }

        return this.ExecuteTillSoil(executionId, requestId, targetX, targetY, charge, requestedDeadlineMs);
    }

    private LocalExecutionReceipt ExecuteTillSoil(string executionId, string requestId, int targetX, int targetY, int charge, long requestedDeadlineMs)
    {
        Vector2 tile = new(targetX, targetY);
        StardewValley.GameLocation location = Game1.player.currentLocation;
        // The tile's soil feature, READ before the hoe swings. `before` used to be the literal "none", so the receipt
        // claimed a transition from nothing to `HoeDirt` that no read had ever seen, and a tile that already carried
        // one was refused without naming what was actually there.
        StardewValley.TerrainFeatures.HoeDirt? dirtBefore = location.GetHoeDirtAtTile(tile);
        string before = DescribeSoilFeature(dirtBefore);
        if (dirtBefore is not null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "soil_already_tilled", $"target={targetX},{targetY};before={before}");
        if (DescribeSoilRefusal(location, targetX, targetY) is { } soilRefusal)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, DescribeSoilRefusalCode(soilRefusal), $"target={targetX},{targetY}{DescribeSoilGuidance(location, targetX, targetY)}");
        if (!TrySelectDeclaredTool(Game1.player, "till_soil", out DeclaredToolSelection selection, out string toolRefusalCode))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, toolRefusalCode, DescribeDeclaredToolRefusal(Game1.player.Items, "till_soil", toolRefusalCode));
        ExecutionState state;
        string reasonCode;
        Dictionary<string, string> evidence = ToolActionEvidence.SelectionFacts(selection);
        try
        {
            if (selection.Tool is not Hoe hoe)
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, $"tool_not_selected:{selection.Category}", $"slot={selection.Slot}");
            if (RefuseToolCharge(charge, hoe, Game1.player, targetX, targetY) is { } chargeRefusal)
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, chargeRefusal, $"target={targetX},{targetY};charge={charge};max={ToolChargeCeiling(hoe)}");
            // THE RECTANGLE IS NOT CENTRED ON THE NAMED TILE, so the tiles it reaches are asked BEFORE the swing. A gold hoe
            // covers a 3x3 whose edges are one row either side of the named one (`Tool.cs:972-982`), so ONE packed row also
            // reaches two rows the plan never named: a keg, a tapper or an artifact spot standing there left the world with
            // no refusal saying so. The named tile's own answers (`soil_already_tilled`, the soil refusal) stay where they
            // are - they answer a different question, about the tile the request named.
            List<Vector2>? footprint = null;
            if (charge > 0)
            {
                footprint = ChargedFootprint.Tiles(hoe, targetX, targetY, charge, Game1.player, out string unreadable);
                if (footprint is null)
                    return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, $"footprint_unavailable:{unreadable}", $"target={targetX},{targetY};charge={charge}");
                List<(Vector2 Tile, string Kind)> undeclared = ChargedFootprint.Undeclared(location, footprint, tile);
                if (undeclared.Count > 0)
                {
                    return this.RememberTerminal(
                        requestId,
                        executionId,
                        ExecutionState.Rejected,
                        $"charged_use_would_destroy:{undeclared[0].Kind}:{undeclared[0].Tile.X:0}:{undeclared[0].Tile.Y:0}",
                        $"target={targetX},{targetY};charge={charge};footprint_tiles={footprint.Count.ToString(CultureInfo.InvariantCulture)};would_destroy={MeleeSweepOccupancy.Describe(undeclared)};blocked_by={new RefusalLayerToken(RefusalLayerKind.Terrain, undeclared[0].Kind).Format()}");
                }
            }

            LocalSoilTillingSpec specification = new(executionId, requestId, location.NameOrUniqueName, targetX, targetY, this.revision, requestedDeadlineMs);
            // The one charged native use, bracketed by the same read on both sides: `Hoe.DoFunction` covers the engine's
            // own rectangle (`Hoe.cs:60,66`), so what changed is measured over the scan box rather than assumed from the
            // charge. The named tile's own read below stays the COMPLETION condition (the footprint is a consequence).
            HashSet<Vector2> tilledBefore = AreaToolFootprint.Observe(targetX, targetY, tile => location.GetHoeDirtAtTile(tile) is not null);
            float staminaBefore = Game1.player.Stamina;
            UseNativeToolOnTile(hoe, location, targetX, targetY, Game1.player, staminaBefore, charge);
            float staminaAfter = Game1.player.Stamina;
            float staminaDelta = staminaAfter - staminaBefore;
            float expectedStaminaCost = hoe.IsEfficient ? 0f : 2f - (Game1.player.FarmingLevel * 0.1f);
            StardewValley.TerrainFeatures.HoeDirt? dirtAfter = location.GetHoeDirtAtTile(tile);
            string after = DescribeSoilFeature(dirtAfter);
            bool tilled = dirtAfter is not null;
            List<Vector2> changed = AreaToolFootprint.Changed(tilledBefore, AreaToolFootprint.Observe(targetX, targetY, scanTile => location.GetHoeDirtAtTile(scanTile) is not null));
            evidence["location"] = specification.Location;
            evidence["target"] = $"{targetX},{targetY}";
            evidence["before"] = before;
            evidence["after"] = after;
            evidence["stamina_before"] = staminaBefore.ToString("0.####", CultureInfo.InvariantCulture);
            evidence["stamina_after"] = staminaAfter.ToString("0.####", CultureInfo.InvariantCulture);
            evidence["stamina_delta"] = staminaDelta.ToString("0.####", CultureInfo.InvariantCulture);
            evidence["expected_stamina_cost"] = expectedStaminaCost.ToString("0.####", CultureInfo.InvariantCulture);
            evidence["charge_requested"] = charge.ToString(CultureInfo.InvariantCulture);
            evidence["charge_applied"] = charge.ToString(CultureInfo.InvariantCulture);
            evidence["window"] = AreaToolFootprint.Window(targetX, targetY);
            evidence["tiles_changed"] = changed.Count.ToString(CultureInfo.InvariantCulture);
            evidence["changed"] = AreaToolFootprint.Format(changed);
            (state, reasonCode) = PostconditionVerdict(tilled, "soil_tilled", "soil_postcondition_unavailable");
        }
        finally
        {
            RestoreToolSelection(Game1.player, selection);
            evidence["tool_restored"] = DescribeToolCategory(Game1.player.CurrentTool);
        }
        return this.RememberTerminal(requestId, executionId, state, reasonCode,
            ToolActionEvidence.Compose(ToolActionEvidence.TillSoil, evidence));
    }

    /// <summary>
    /// One `HoeDirt` read of a tile, named the way a receipt's `before`/`after` fields name it.
    ///
    /// <para>
    /// The read is the engine's own (`GameLocation.GetHoeDirtAtTile`), the one `IsTillableTile` and the
    /// `soil_already_tilled` gate already ask. It is named here rather than inlined so both ends of the transition are
    /// spelled by one function instead of by two literals that could drift apart.
    /// </para>
    /// </summary>
    private static string DescribeSoilFeature(StardewValley.TerrainFeatures.HoeDirt? dirt) => dirt is null ? "none" : "HoeDirt";

    /// <summary>
    /// equip_tool/v2: resolves one canonical semantic tool category to the
    /// deterministically best owned item on the game thread, switches to that
    /// slot, and proves it with a ReferenceEquals postcondition. slot stays
    /// Mod-private and is never accepted from the wire.
    /// </summary>
    public LocalExecutionReceipt RequestLocalEquipTool(string requestId, string? requestedTool, long requestedDeadlineMs)
    {
        if (this.BeginLocalExecution(requestId, out string executionId, out long nowMs) is LocalExecutionReceipt replay) return replay;
        if (!this.TryGetBoundActor(out Farmer? boundActor, out string scopeReason) || boundActor is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, scopeReason, null);

        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is { } admissionRefusal)
            return admissionRefusal;
        if (requestedTool is null || !FarmhandActionCatalog.ToolEnum.Contains(requestedTool, StringComparer.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_tool_selector", requestedTool is null ? null : $"tool={requestedTool}");

        int? slot = SelectToolSlot(Game1.player, requestedTool);
        if (slot is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "tool_not_found", $"tool={requestedTool}");
        Tool? selectedTool = Game1.player.Items[slot.Value] as Tool;
        if (selectedTool is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "tool_not_found", $"tool={requestedTool};slot={slot.Value}");

        if (ReferenceEquals(Game1.player.CurrentTool, selectedTool))
        {
            string? heldToolName = DescribeTool(Game1.player.CurrentTool);
            return this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "already_equipped", $"tool={requestedTool};before={heldToolName ?? "none"};expected={heldToolName ?? "none"};after={heldToolName ?? "none"}");
        }

        string? expectedTool = DescribeTool(selectedTool);
        string? previousTool = DescribeTool(Game1.player.CurrentTool);
        Game1.player.CurrentToolIndex = slot.Value;
        string? currentTool = DescribeTool(Game1.player.CurrentTool);
        if (!string.Equals(currentTool, expectedTool, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "tool_selection_postcondition_unavailable", $"tool={requestedTool};before={previousTool ?? "none"};expected={expectedTool ?? "none"};actual={currentTool ?? "none"}");

        return this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "tool_equipped", $"tool={requestedTool};before={previousTool ?? "none"};expected={expectedTool};after={currentTool}", publish: false);
        // `publish: false` above is `design/fact-authority.md` §1: 「工具被装上了」 is a STEP of the plan, not an event
        // of the world - that document's not-fact column files it under 「属于结算的证据」. The plan's own node names the
        // action and the tool it asked for, and this receipt's evidence line names the tool the hand actually holds, so
        // the settlement that ends the step still says WHICH one it was. What is gone is the second spelling: the
        // receipt answers the dispatch that asked for it and the plan's journal row, and the seam does not publish it.
    }

    private static int? SelectToolSlot(Farmer player, string tool)
    {
        int bestSlot = -1;
        int bestRank = -1;
        for (int slot = 0; slot < player.Items.Count; slot++)
        {
            if (player.Items[slot] is not Tool item)
                continue;
            if (!MatchesToolCategory(item, tool))
                continue;
            int rank = tool == "weapon" ? ItemRankForWeapon(item) : item.UpgradeLevel;
            if (rank > bestRank || (rank == bestRank && (bestSlot < 0 || slot < bestSlot)))
            {
                bestRank = rank;
                bestSlot = slot;
            }
        }
        return bestSlot < 0 ? null : bestSlot;
    }

    /// <summary>
    /// The ONE mapping between a native tool and the category word an action's own `tool:&lt;category&gt;` claim uses
    /// (<see cref="FarmhandActionCatalog.ToolEnum"/>), or null when this Mod has no word for the tool. Every reading of
    /// "which category is this tool" goes through it - <see cref="MatchesToolCategory"/> (does this tool satisfy that
    /// claim?), <see cref="DescribeToolCategory"/> (what did the handler take and put back?) and the slot list's
    /// published category - so a claim, a receipt and the snapshot can never name the same tool two different ways.
    /// A scythe is a MeleeWeapon, so it is tested before `weapon`; the words partition the vocabulary, which is what
    /// makes `weapon` mean "a weapon that is not a scythe". `lantern` is the one word here that is not a resource tool:
    /// `toggle_tool_light` drives the actor's own lantern, and the action could only take it from the pack if the pack
    /// could name it.
    /// </summary>
    internal static string? ToolCategory(Tool? tool) => tool switch
    {
        Axe => "axe",
        Pickaxe => "pickaxe",
        Hoe => "hoe",
        WateringCan => "watering_can",
        FishingRod => "fishing_rod",
        Shears => "shears",
        MilkPail => "milk_pail",
        Pan => "pan",
        Lantern => "lantern",
        Raft => "raft",
        MeleeWeapon weapon when weapon.isScythe() => "scythe",
        MeleeWeapon or Slingshot => "weapon",
        _ => null,
    };

    private static bool MatchesToolCategory(Tool item, string tool) =>
        string.Equals(ToolCategory(item), tool, StringComparison.Ordinal);

    /// <summary>
    /// The tool one action's own registration declares: the category from `tool:&lt;category&gt;` and the upgrade tier
    /// from that claim's value. Reading it from the registration rather than from a table in the handler is what keeps
    /// "which tool" a published fact - `cut_weeds` needs the scythe because its registration claims one, not because
    /// this file remembers it.
    /// </summary>
    internal static FarmhandActionResourceTemplateClaim? DeclaredToolClaim(string actionId)
    {
        FarmhandActionRegistration? registration = FarmhandActionCatalog.Registrations
            .FirstOrDefault(candidate => string.Equals(candidate.ActionId, actionId, StringComparison.Ordinal));
        return registration?.Descriptor?.ResourceTemplate
            .FirstOrDefault(claim => claim.Key.StartsWith("tool:", StringComparison.Ordinal));
    }

    /// <summary>
    /// The upgrade-level range one claim value permits: `BasicOnly` is exactly the basic tool, and every other word -
    /// `AnyUpgrade` today - is every level. A word this Mod does not know says nothing about level, which is the same
    /// reading the Host publishes for the claim.
    ///
    /// <para>
    /// NO ACTION DECLARES `BasicOnly` ANY MORE, and the reason is worth keeping here: its old docblock said the native
    /// handlers "refuse an upgraded one by name". Checked against the game, that is backwards - `Pickaxe` refuses
    /// `UpgradeLevel &lt; 2` (it demands more than basic, and only for boulder tiles the target predicate excludes) and
    /// `Axe` refuses no upgrade level at all. So the range admitted exactly the tier the game rejects. The value is kept
    /// because the BodyProgram wire vocabulary carries it (`BodyProgramResourceTemplateValue.ToolBasicOnly`), so a
    /// persisted journal from a build that emitted it still reads; nothing produces it now.
    /// </para>
    /// </summary>
    private static (int Minimum, int Maximum) DeclaredToolUpgradeBounds(FarmhandResourceTemplateValue requirement) =>
        requirement switch
        {
            FarmhandResourceTemplateValue.BasicOnly => (0, 0),
            _ => (0, int.MaxValue),
        };

    /// <summary>
    /// Resolves one action's declared tool against the pack it is GIVEN: the slot whose tool satisfies the claim, or the
    /// NAMED reason nothing does. It reads the pack and never the held tool - holding an axe is not a reason a scythe
    /// action cannot run - and it mutates nothing, so a test can ask the same question with a synthetic pack.
    /// </summary>
    internal static DeclaredToolResolution ResolveDeclaredTool(IList<Item?> items, string actionId)
    {
        FarmhandActionResourceTemplateClaim? claim = DeclaredToolClaim(actionId);
        if (claim is null)
            return new DeclaredToolResolution(string.Empty, -1, $"tool_requirement_undeclared:{actionId}");
        (int minimum, int maximum) = DeclaredToolUpgradeBounds(claim.Value);
        string word = claim.Key["tool:".Length..];
        return ResolveOwnedTool(items, word, tool => SatisfiesToolRequirement(tool, word), minimum, maximum);
    }

    /// <summary>
    /// The words a `tool:` claim may use that are NOT one category, each with the native question it asks. ONE table, for
    /// the same reason <see cref="ToolCategory"/> is one: the claim word, the refusal word (`tool_not_owned:&lt;word&gt;`)
    /// and the predicate the resolver runs have to be the same fact, or a caller is told to fetch a tool the handler was
    /// never looking for.
    ///
    /// <para>
    /// A word earns a place here only when no category can say it. <c>axe_or_pickaxe</c> is a SET - two categories, and a
    /// claim names one. <c>heavy_hitter</c> is the game's own predicate (<c>Tool.isHeavyHitter</c>: MeleeWeapon, Hoe, Axe,
    /// Pickaxe) and is asked of the game rather than re-derived as a list of categories, so a modded Tool overriding it is
    /// admitted exactly as the native branch admits it. <c>heavy_hitter_not_melee_weapon</c> is the cask's own guard
    /// (<c>Cask.cs:43</c>: <c>t.isHeavyHitter() &amp;&amp; !(t is MeleeWeapon)</c>), which is why a scythe opens a container
    /// but not a cask.
    /// </para>
    /// </summary>
    internal static readonly IReadOnlyDictionary<string, Func<Tool, bool>> ToolRequirementPredicates =
        new Dictionary<string, Func<Tool, bool>>(StringComparer.Ordinal)
        {
            ["axe_or_pickaxe"] = tool => tool is Axe or Pickaxe,
            ["heavy_hitter"] = tool => tool.isHeavyHitter(),
            ["heavy_hitter_not_melee_weapon"] = tool => tool.isHeavyHitter() && tool is not MeleeWeapon,
        };

    /// <summary>
    /// Whether a tool satisfies the WORD a claim names: a predicate above, or a category from <see cref="ToolCategory"/>.
    /// The category half is delegated rather than restated, so every tool keeps exactly one category name.
    /// </summary>
    internal static bool SatisfiesToolRequirement(Tool tool, string word) =>
        ToolRequirementPredicates.TryGetValue(word, out Func<Tool, bool>? predicate)
            ? predicate(tool)
            : MatchesToolCategory(tool, word);

    /// <summary>
    /// The one ranking behind both readings of "which tool does this need": the tool a row's `tool:` claim declares,
    /// and the tool a CLUMP's own native switch demands.
    ///
    /// <para>
    /// The second caller is why this is a parameterised resolver rather than the body of
    /// <see cref="ResolveDeclaredTool"/>. `ResourceClump.performToolAction` decides the family and the minimum upgrade
    /// from `parentSheetIndex` (ResourceClump.cs:150-234), so no single claim on an action row can state it - but the
    /// QUESTION is the same one, and answering it with a second hand-written loop beside this one is the two-spellings
    /// defect this file already carries scars from. `minimum`/`maximum` come from whichever declaration owns the fact.
    /// </para>
    /// <para>
    /// <paramref name="OwnedUpgrade"/> on the answer is the best level the pack actually carries, so a refusal can
    /// report `need 2, have 0` without recomputing the ranking at the call site.
    /// </para>
    /// </summary>
    internal static DeclaredToolResolution ResolveOwnedTool(IList<Item?> items, string category, int minimum, int maximum = int.MaxValue) =>
        ResolveOwnedTool(items, category, tool => MatchesToolCategory(tool, category), minimum, maximum);

    /// <summary>
    /// The same ranking, with the QUESTION passed in instead of assumed: a claim word may be a category (matched by
    /// <see cref="MatchesToolCategory"/>), a set of categories, a native predicate, or a category narrowed by the target the
    /// action is about to swing at. One loop, one ranking, one refusal vocabulary - a second selection path would be a
    /// second place for "which tool" to disagree with the claim the caller was shown.
    /// </summary>
    internal static DeclaredToolResolution ResolveOwnedTool(IList<Item?> items, string word, Func<Tool, bool> satisfies, int minimum, int maximum)
    {
        int bestSlot = -1;
        int bestLevel = -1;
        int ownedLevel = -1;
        for (int slot = 0; slot < items.Count; slot++)
        {
            if (items[slot] is not Tool tool || !satisfies(tool))
                continue;
            ownedLevel = Math.Max(ownedLevel, tool.UpgradeLevel);
            if (tool.UpgradeLevel < minimum || tool.UpgradeLevel > maximum)
                continue;
            if (tool.UpgradeLevel > bestLevel || (tool.UpgradeLevel == bestLevel && (bestSlot < 0 || slot < bestSlot)))
            {
                bestSlot = slot;
                bestLevel = tool.UpgradeLevel;
            }
        }
        if (bestSlot >= 0)
            return new DeclaredToolResolution(word, bestSlot, null, ownedLevel);
        if (ownedLevel < 0)
            return new DeclaredToolResolution(word, -1, PendingToolUpgradeRefusal(satisfies, word) ?? $"tool_not_owned:{word}", ownedLevel);
        return new DeclaredToolResolution(
            word,
            -1,
            $"tool_upgrade_insufficient:{word}:{minimum.ToString(CultureInfo.InvariantCulture)}:{ownedLevel.ToString(CultureInfo.InvariantCulture)}",
            ownedLevel);
    }

    /// <summary>
    /// The reason the pack answers nothing, when the tool that would have answered is at Clint's:
    /// <c>tool_being_upgraded:&lt;category&gt;:&lt;daysLeft&gt;</c>, or
    /// <c>tool_being_upgraded:&lt;category&gt;:ready_at_clint</c> once the counter has run out. Null when nothing is being
    /// upgraded, or the tool at the blacksmith's is not one this claim would have taken.
    ///
    /// <para>
    /// <c>tool_not_owned</c> is the resolver's one word for "the pack cannot answer", and while an upgrade is in flight it
    /// is false in the expensive direction: the player owns the tool, cannot buy a second one, and the only repair is to
    /// wait - which is cheap the moment it is told. The engine keeps the fact in two fields (<c>Farmer.cs:628-632</c>):
    /// <c>toolBeingUpgraded</c> holds the tool itself and <c>daysLeftForToolUpgrade</c> the counter, which
    /// <c>Tool.cs:889-890</c> sets to two days on purchase and <c>Farmer.cs:3535-3538</c> decrements at day start. The
    /// tool is handed back when the actor talks to Clint (<c>GameLocation.cs:10961-10966</c>), not on a timer, which is
    /// why the state is READ here and published nowhere: the actor that started the upgrade remembers it, and this is a
    /// reason for the moment of refusal rather than a fact republished every turn.
    /// </para>
    /// <para>
    /// <paramref name="satisfies"/> is the claim's own question, so a tool at the blacksmith's that this action would
    /// never have looked for cannot account for its refusal. A counter at zero names no number: the engine's own reading
    /// splits at <c>&lt;= 0</c> and the tool is then ready but uncollected (<c>GameLocation.cs:10961</c>), so
    /// <c>tool_being_upgraded:hoe:0</c> would read as "done" about the request it is refusing, while
    /// <c>ready_at_clint</c> says what to do instead. Whether the actor can take it is the counter's own answer
    /// (<c>GameLocation.cs:10963</c>, <c>Clint_NoInventorySpace</c>), not this refusal's.
    /// </para>
    /// </summary>
    private static string? PendingToolUpgradeRefusal(Func<Tool, bool> satisfies, string word)
    {
        Tool? upgrading = Game1.player?.toolBeingUpgraded?.Value;
        if (upgrading is null || !satisfies(upgrading))
            return null;
        int daysLeft = Game1.player!.daysLeftForToolUpgrade?.Value ?? 0;
        string category = ToolCategory(upgrading) ?? word;
        return daysLeft > 0
            ? $"tool_being_upgraded:{category}:{daysLeft.ToString(CultureInfo.InvariantCulture)}"
            : $"tool_being_upgraded:{category}:ready_at_clint";
    }

    /// <summary>
    /// Takes the tool the action's registration declares as the actor's current INPUT, and saves the index that was
    /// held. Equipping in Stardew is input selection, not an action: `Farmer.CurrentTool` is `Items[CurrentToolIndex] as
    /// Tool`, so the native building-chest load already does exactly this - save `CurrentToolIndex`, hold the slot for
    /// the call, restore it afterwards (farmhandexecutioncontroller.buildingchestactions.cs:246-270). It spends no
    /// stamina, advances no time and mutates no world state, so its only failures are the pack's own.
    /// </summary>
    private static bool TrySelectDeclaredTool(
        Farmer farmer,
        string actionId,
        out DeclaredToolSelection selection,
        out string refusalCode) =>
        TrySelectDeclaredTool(farmer, actionId, _ => true, out selection, out refusalCode);

    /// <summary>
    /// The same selection, narrowed by a fact only the TARGET can answer - <c>remove_placed_item</c> needs a tool that
    /// removes THIS object, and the pack may hold both an Axe and a Pickaxe while only one of them works on it. The
    /// narrowing can only NARROW: a tool must still satisfy the action's own claim word first, so the refusal a caller
    /// reads is still the claim's own <c>tool_not_owned:&lt;word&gt;</c> when the pack carries nothing that qualifies.
    /// </summary>
    private static bool TrySelectDeclaredTool(
        Farmer farmer,
        string actionId,
        Func<Tool, bool> alsoSatisfies,
        out DeclaredToolSelection selection,
        out string refusalCode)
    {
        selection = default;
        refusalCode = string.Empty;
        FarmhandActionResourceTemplateClaim? claim = DeclaredToolClaim(actionId);
        if (claim is null)
        {
            refusalCode = $"tool_requirement_undeclared:{actionId}";
            return false;
        }
        (int minimum, int maximum) = DeclaredToolUpgradeBounds(claim.Value);
        string word = claim.Key["tool:".Length..];
        DeclaredToolResolution resolution = ResolveOwnedTool(
            farmer.Items,
            word,
            tool => SatisfiesToolRequirement(tool, word) && alsoSatisfies(tool),
            minimum,
            maximum);
        if (resolution.RefusalCode is not null)
        {
            refusalCode = resolution.RefusalCode;
            return false;
        }
        return SelectResolvedTool(farmer, resolution, out selection, out refusalCode);
    }

    private static bool TrySelectRequiredTool(
        Farmer farmer,
        string category,
        int minimumUpgrade,
        out DeclaredToolSelection selection,
        out DeclaredToolResolution resolution,
        out string refusalCode)
    {
        selection = default;
        refusalCode = string.Empty;
        resolution = ResolveOwnedTool(farmer.Items, category, minimumUpgrade);
        if (resolution.RefusalCode is not null)
        {
            refusalCode = resolution.RefusalCode;
            return false;
        }
        return SelectResolvedTool(farmer, resolution, out selection, out refusalCode);
    }

    private static bool SelectResolvedTool(
        Farmer farmer,
        DeclaredToolResolution resolution,
        out DeclaredToolSelection selection,
        out string refusalCode)
    {
        selection = default;
        refusalCode = string.Empty;
        Tool tool = (Tool)farmer.Items[resolution.Slot]!;
        int previousSlot = farmer.CurrentToolIndex;
        Tool? previousTool = previousSlot >= 0 && previousSlot < farmer.Items.Count ? farmer.Items[previousSlot] as Tool : null;
        farmer.CurrentToolIndex = resolution.Slot;
        if (!ReferenceEquals(farmer.CurrentTool, tool))
        {
            farmer.CurrentToolIndex = previousSlot;
            refusalCode = $"tool_not_selected:{resolution.Category}";
            return false;
        }
        selection = new DeclaredToolSelection(tool, resolution.Category, resolution.Slot, previousSlot, previousTool);
        return true;
    }

    private static void RestoreToolSelection(Farmer farmer, DeclaredToolSelection selection) =>
        farmer.CurrentToolIndex = selection.PreviousSlot;

    private static string SelectionSuffix(DeclaredToolSelection selection) =>
        ToolActionEvidence.SelectionSuffix(selection, DescribeToolCategory(Game1.player.CurrentTool));

    /// <summary>
    /// The category of whatever the actor is holding, in the vocabulary a `tool:&lt;category&gt;` claim speaks, or
    /// `none` when nothing is held or the held thing is not a tool this Mod can name - the one literal the Host
    /// accepts for the absent equipped tool.
    /// </summary>
    internal static string DescribeToolCategory(Tool? tool) => ToolCategory(tool) ?? "none";

    private static string DescribeDeclaredToolRefusal(IList<Item?> items, string actionId, string refusalCode, int? requestedSlot = null)
    {
        DeclaredToolResolution resolution = ResolveDeclaredTool(items, actionId);
        string detail = resolution.RefusalDetail ?? (resolution.Category.Length > 0 ? resolution.Category : "undeclared");
        return (requestedSlot is int slot ? $"slot={slot.ToString(CultureInfo.InvariantCulture)};" : string.Empty)
            + $"tool_refusal={refusalCode}"
            + $";blocked_by={new RefusalLayerToken(RefusalLayerKind.Tool, detail).Format()}";
    }

    /// <summary>
    /// Chop exactly one TerrainFeature Tree stump (stump.Value == true) with an
    /// equipped Axe of any upgrade level. ResourceClump stumps (600/602) are
    /// NOT this action's targets: they belong exclusively to clear_debris, per
    /// the target-entity orthogonality decision (2026-09-23). The one native
    /// Axe.DoFunction swing settles the action; a missing/unchanged stump is a
    /// fresh postcondition failure, never a claimed success.
    /// </summary>
    public LocalExecutionReceipt RequestLocalChopStump(string requestId, int slot, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs) =>
        this.RequestLocalTileTarget(
            "chop_stump", requestId, targetX, targetY, expectedTargetId, requestedDeadlineMs,
            AdmissionActionabilityProfile.Physical,
            authorize: null,
            gate: location =>
            {
                if (ResolveDeclaredTool(Game1.player.Items, "chop_stump").RefusalCode is { } toolRefusal)
                    return new TileTargetRefusal(toolRefusal, DescribeDeclaredToolRefusal(Game1.player.Items, "chop_stump", toolRefusal, slot));
                return DescribeTreeStumpRefusal(location, targetX, targetY, expectedTargetId);
            },
            inReach: IsTileWithinToolReach,
            execute: (executionId, admittedRequestId) => this.ExecuteChopStump(executionId, admittedRequestId, slot, targetX, targetY, expectedTargetId));

    private static TileTargetRefusal? DescribeTreeStumpRefusal(GameLocation location, int targetX, int targetY, string expectedTargetId) =>
        location.terrainFeatures.TryGetValue(new Vector2(targetX, targetY), out StardewValley.TerrainFeatures.TerrainFeature? feature)
            && feature is StardewValley.TerrainFeatures.Tree tree
            && tree.stump.Value
            && string.Equals(BuildTreeStumpTargetId(location, targetX, targetY, tree), expectedTargetId, StringComparison.Ordinal)
                ? null
                : new TileTargetRefusal("stump_target_changed", $"target={targetX},{targetY}");

    private LocalExecutionReceipt ExecuteChopStump(string executionId, string requestId, int slot, int targetX, int targetY, string expectedTargetId)
    {
        if (!TrySelectDeclaredTool(Game1.player, "chop_stump", out DeclaredToolSelection selection, out string toolRefusalCode))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, toolRefusalCode, DescribeDeclaredToolRefusal(Game1.player.Items, "chop_stump", toolRefusalCode, slot));
        ExecutionState state;
        string reasonCode;
        string evidence;
        try
        {
            if (selection.Tool is not Axe axe)
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, $"tool_not_selected:{selection.Category}", $"slot={selection.Slot}");
            GameLocation location = Game1.player.currentLocation;
            Vector2 tile = new(targetX, targetY);
            if (!location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? feature) || feature is not StardewValley.TerrainFeatures.Tree tree
                || !tree.stump.Value
                || !string.Equals(BuildTreeStumpTargetId(location, targetX, targetY, tree), expectedTargetId, StringComparison.Ordinal))
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "stump_target_changed", $"target={targetX},{targetY}");
            float before = tree.health.Value;
            string treeType = tree.treeType.Value;
            int axeLevel = axe.UpgradeLevel;
            const int maximumSwingCount = 12;
            // The stamina floor, checked BEFORE the first swing.
            //
            // The loop below cannot know how many swings it will need - a stump falls when its health reaches zero,
            // not when a budget says so - so the worst case it is willing to spend is the cap itself, and that is what
            // gets priced. Refusing when the worst case does not fit is the honest answer: the alternative is letting
            // the actor swing through to the engine's -15 pass-out, which halves next day's stamina and ends a multi-day
            // routine outright (`Game1.cs:6452`).
            ToolStaminaVerdict stamina = ToolStaminaGuard.Check(
                Game1.player.Stamina,
                ToolStaminaGuard.EstimatedCost(maximumSwingCount, Game1.player.ForagingLevel, axe.IsEfficient));
            if (!stamina.Allowed)
                return this.RememberTerminal(
                    requestId,
                    executionId,
                    ExecutionState.Rejected,
                    stamina.ReasonCode,
                    $"target={targetX},{targetY};tree_type={treeType};{stamina.Evidence};swings_worst_case={maximumSwingCount}");

            int swingCount = 0;
            float staminaBefore = Game1.player.Stamina;
            while (tree.health.Value > 0f && swingCount < maximumSwingCount)
            {
                UseNativeToolOnTile(axe, location, targetX, targetY, Game1.player, staminaBefore);
                swingCount++;
            }
            float staminaAfter = Game1.player.Stamina;
            float staminaDelta = staminaAfter - staminaBefore;
            float perSwingStaminaCost = axe.IsEfficient ? 0f : 2f - (Game1.player.ForagingLevel * 0.1f);
            float expectedStaminaCost = perSwingStaminaCost * swingCount;
            bool removed = tree.health.Value <= -100f;
            bool terrainGone = !location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? afterFeature)
                || !ReferenceEquals(afterFeature, tree);
            string healthAfterText = removed ? "destroyed" : terrainGone ? "removed"
                : afterFeature is StardewValley.TerrainFeatures.Tree afterTree
                    ? afterTree.health.Value.ToString("0.##", CultureInfo.InvariantCulture)
                    : "missing";
            evidence = $"target={expectedTargetId};type=tree_stump;tree={treeType};tool=axe;tool_level={axeLevel};health_before={before.ToString("0.##", CultureInfo.InvariantCulture)};health_after={healthAfterText};swings={swingCount};stump_removed={(removed || terrainGone).ToString().ToLowerInvariant()};stamina_before={staminaBefore.ToString("0.####", CultureInfo.InvariantCulture)};stamina_after={staminaAfter.ToString("0.####", CultureInfo.InvariantCulture)};stamina_delta={staminaDelta.ToString("0.####", CultureInfo.InvariantCulture)};expected_stamina_cost={expectedStaminaCost.ToString("0.####", CultureInfo.InvariantCulture)}";
            (state, reasonCode) = PostconditionVerdict(removed || terrainGone, "stump_cleared", "stump_clear_postcondition_unavailable");
        }
        finally
        {
            RestoreToolSelection(Game1.player, selection);
        }
        evidence += $";{SelectionSuffix(selection)}";
        return this.RememberTerminal(requestId, executionId, state, reasonCode, evidence);
    }

    /// <summary>
    /// Cut exactly one adjacent Weed object with an equipped scythe through the
    /// native Object.performToolAction weeds branch (target version 1.6). The
    /// scythe must be the current tool and the target object must still be the
    /// requested weed; a removed weed is the only success postcondition. No
    /// other litter class is touched (stones stay in break_rock_source, debris
    /// clumps in clear_debris).
    /// </summary>
    public LocalExecutionReceipt RequestLocalCutWeeds(string requestId, int slot, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs) =>
        this.RequestLocalTileTarget(
            "cut_weeds", requestId, targetX, targetY, expectedTargetId, requestedDeadlineMs,
            AdmissionActionabilityProfile.Physical,
            authorize: null,
            gate: location =>
            {
                if (ResolveDeclaredTool(Game1.player.Items, "cut_weeds").RefusalCode is { } toolRefusal)
                    return new TileTargetRefusal(toolRefusal, $"slot={slot}");
                return DescribeWeedRefusal(location, targetX, targetY, expectedTargetId);
            },
            inReach: IsTileWithinToolReach,
            execute: (executionId, admittedRequestId) => this.ExecuteCutWeeds(executionId, admittedRequestId, slot, targetX, targetY, expectedTargetId));

    private static TileTargetRefusal? DescribeWeedRefusal(GameLocation location, int targetX, int targetY, string expectedTargetId) =>
        location.objects.TryGetValue(new Vector2(targetX, targetY), out StardewValley.Object? probeWeed)
            && probeWeed.IsWeeds()
            && string.Equals(BuildWeedTargetId(location, targetX, targetY, probeWeed), expectedTargetId, StringComparison.Ordinal)
                ? null
                : new TileTargetRefusal("weed_target_changed", $"target={targetX},{targetY}");

    /// <summary>
    /// Cut one grass tuft (the TerrainFeature `Grass`, not the Object-layer weeds)
    /// with an equipped scythe through the native
    /// <c>Grass.performToolAction(Tool, explosion, tile)</c> chain
    /// (<c>Grass.cs:365</c>), which deducts <c>numberOfWeeds</c> to zero and, on
    /// death, runs <c>TryDropItemsOnCut</c> (<c>Grass.cs:455</c>): grassType 1/7
    /// feeds Hay into a silo via <c>GameLocation.StoreHayInAnySilo</c>
    /// (<c>GameLocation.cs:16511</c>, 0 = fully stored, &gt;0 = silo-full remainder),
    /// grassType 6 drops rare items. The target tuft must remain the requested
    /// grass and the scythe must be the current tool; a removed tuft is the only
    /// success postcondition. No other TerrainFeature class is touched.
    /// </summary>
    public LocalExecutionReceipt RequestLocalCutGrass(string requestId, int slot, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs) =>
        this.RequestLocalTileTarget(
            "cut_grass", requestId, targetX, targetY, expectedTargetId, requestedDeadlineMs,
            AdmissionActionabilityProfile.Physical,
            authorize: null,
            gate: location =>
            {
                if (ResolveDeclaredTool(Game1.player.Items, "cut_grass").RefusalCode is { } toolRefusal)
                    return new TileTargetRefusal(toolRefusal, $"slot={slot}");
                return DescribeGrassRefusal(location, targetX, targetY, expectedTargetId);
            },
            inReach: IsTileWithinToolReach,
            execute: (executionId, admittedRequestId) => this.ExecuteCutGrass(executionId, admittedRequestId, slot, targetX, targetY, expectedTargetId));

    private static TileTargetRefusal? DescribeGrassRefusal(GameLocation location, int targetX, int targetY, string expectedTargetId) =>
        location.terrainFeatures.TryGetValue(new Vector2(targetX, targetY), out StardewValley.TerrainFeatures.TerrainFeature? probeFeature)
            && probeFeature is StardewValley.TerrainFeatures.Grass probeGrass
            && string.Equals(BuildGrassTargetId(location, targetX, targetY, probeGrass), expectedTargetId, StringComparison.Ordinal)
                ? null
                : new TileTargetRefusal("grass_target_changed", $"target={targetX},{targetY}");

    private LocalExecutionReceipt ExecuteCutGrass(string executionId, string requestId, int slot, int targetX, int targetY, string expectedTargetId)
    {
        if (!TrySelectDeclaredTool(Game1.player, "cut_grass", out DeclaredToolSelection selection, out string toolRefusalCode))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, toolRefusalCode, $"slot={slot}");
        Dictionary<string, string> evidence = ToolActionEvidence.SelectionFacts(selection);
        ExecutionState state;
        string reasonCode;
        try
        {
            if (selection.Tool is not MeleeWeapon weapon)
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, $"tool_not_selected:{selection.Category}", $"slot={selection.Slot}");
            GameLocation location = Game1.player.currentLocation;
            Vector2 tile = new(targetX, targetY);
            if (!location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? feature) || feature is not StardewValley.TerrainFeatures.Grass grass
                || !string.Equals(BuildGrassTargetId(location, targetX, targetY, grass), expectedTargetId, StringComparison.Ordinal))
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "grass_target_changed", $"target={targetX},{targetY}");

            int weedsBefore = grass.numberOfWeeds.Value;
            int grassType = grass.grassType.Value;
            float staminaBefore = Game1.player.Stamina;
            const int maximumSwingCount = 8;
            ToolStaminaVerdict grassStamina = ToolStaminaGuard.Check(
                Game1.player.Stamina,
                ToolStaminaGuard.PerSwingCharge(Game1.player.ForagingLevel, weapon.IsEfficient) * maximumSwingCount);
            if (!grassStamina.Allowed)
                return this.RememberTerminal(
                    requestId,
                    executionId,
                    ExecutionState.Rejected,
                    grassStamina.ReasonCode,
                    $"target={targetX},{targetY};{grassStamina.Evidence};swings_worst_case={maximumSwingCount}");
            int swingCount = 0;
            bool removed = false;
            while (!removed && swingCount < maximumSwingCount)
            {
                bool cut = grass.performToolAction(weapon, 0, tile);
                swingCount++;
                if (cut)
                {
                    location.terrainFeatures.Remove(tile);
                    removed = true;
                }
                else
                {
                    removed = !location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? afterFeature)
                        || !ReferenceEquals(afterFeature, grass);
                }
            }
            float staminaAfter = Game1.player.Stamina;
            float staminaDelta = staminaAfter - staminaBefore;
            // The scythe is a MeleeWeapon: no native code path deducts stamina for a
            // melee swing (only Axe/Hoe/Pickaxe/WateringCan/MilkPail/Shears do), so the
            // expected embodied cost is exactly zero, same as cut_weeds.
            float expectedStaminaCost = 0f;
            // Hay accounting is deliberately NOT recomputed here. This used to call
            // GameLocation.StoreHayInAnySilo to "observe" the cut — but that method is a
            // WRITE (GameLocation.cs:16511 does currentLocation.tryToAddHay(count) and
            // increments piecesOfHay), and the native cut already stored the hay inside
            // Grass.TryDropItemsOnCut (Grass.cs:489). Calling it again added 1-2 hay to a
            // silo on every successful cut — and added it even when the native probability
            // roll did not — silently polluting durable world state.
            //
            // The outcome of that roll is not observable from here without re-deriving it,
            // so the receipt reports only what actually changed and is true: the tuft is
            // gone (and the evidence key below says exactly that).
            evidence["target"] = expectedTargetId;
            evidence["type"] = "grass";
            evidence["tool"] = "scythe";
            evidence["grass_type"] = grassType.ToString(CultureInfo.InvariantCulture);
            evidence["weeds_before"] = weedsBefore.ToString(CultureInfo.InvariantCulture);
            evidence["weeds_after"] = removed
                ? "removed"
                : location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? remainingFeature) && remainingFeature is StardewValley.TerrainFeatures.Grass remainingGrass
                    ? remainingGrass.numberOfWeeds.Value.ToString(CultureInfo.InvariantCulture)
                    : "missing";
            evidence["swings"] = swingCount.ToString(CultureInfo.InvariantCulture);
            evidence["removed"] = removed.ToString().ToLowerInvariant();
            evidence["tuft_removed"] = removed.ToString().ToLowerInvariant();
            evidence["stamina_before"] = staminaBefore.ToString("0.####", CultureInfo.InvariantCulture);
            evidence["stamina_after"] = staminaAfter.ToString("0.####", CultureInfo.InvariantCulture);
            evidence["stamina_delta"] = staminaDelta.ToString("0.####", CultureInfo.InvariantCulture);
            evidence["expected_stamina_cost"] = expectedStaminaCost.ToString("0.####", CultureInfo.InvariantCulture);
            (state, reasonCode) = PostconditionVerdict(removed, "grass_cut", "grass_cut_postcondition_unavailable");
        }
        finally
        {
            RestoreToolSelection(Game1.player, selection);
            evidence["tool_restored"] = DescribeToolCategory(Game1.player.CurrentTool);
        }
        return this.RememberTerminal(requestId, executionId, state, reasonCode, ToolActionEvidence.Compose(ToolActionEvidence.CutGrass, evidence));
    }

    /// <summary>
    /// One scythe swing over the engine's own arc instead of one tile at a time.
    ///
    /// <para>
    /// THE REQUEST NAMES THE TILE THE ACTOR MUST FACE, and nothing else. A scythe's area is not a footprint a caller can
    /// state: `MeleeWeapon.DoDamage` derives one rectangle per animation frame from the wielder's bounding box and the
    /// facing (`MeleeWeapon.cs:694-867`), so "cut here" can only mean "stand on a cardinal neighbour of this tile, face
    /// it, swing once". A diagonal stance refuses `sweep_needs_cardinal_stance` rather than swinging at whatever
    /// direction the actor last faced, because the facing IS the arc's orientation.
    /// </para>
    /// <para>
    /// IT DESTROYS ONLY WHAT THE CALLER NAMED. The engine's arc reaches behind the actor as well as in front, so every
    /// other arc tile is checked before the swing against the occupants the catalogue marks destructive (`grass`,
    /// `crop`) and the action refuses `sweep_would_destroy:&lt;occupant&gt;` naming the tiles - the rule the `for_each`
    /// heal already applies to a pass over tiles nobody named. The named tile is hers to destroy: `cut_grass` and
    /// `scythe_crop` already let her, on one tile she can foresee.
    /// </para>
    /// <para>
    /// THE NAMED TILE MUST BE ONE THIS SWING CAN MOVE. Completion is the NAMED tile moving, so a tile holding an occupant
    /// the scythe family never declared (`twig`, `stone`, a tree, a placed machine, or nothing at all) is refused before
    /// the swing as `sweep_target_not_scythe_work:&lt;occupant&gt;`, with the occupant, its tile and the published action
    /// that clears it (`clears_with`). Measured `round63`: the admitted alternative was a swing that cut an unnamed weed
    /// and answered `scythe_sweep_partial`, which is a side effect the caller never asked for instead of the fact it
    /// needed.
    /// </para>
    /// <para>
    /// THE RECEIPT IS TWO READS ON EITHER SIDE OF THE ONE CALL, and it claims no combat: `DoDamage` also damages
    /// monsters and destroys projectiles, and six evaluations are not vanilla's seven, so nothing about hits or kills is
    /// reported. `PartiallySucceeded` is the honest state when the arc held more work than the swing did - the named
    /// tile is the completion condition and the rest of the arc is the footprint.
    /// </para>
    /// </summary>
    public LocalExecutionReceipt RequestLocalSweepScythe(string requestId, int targetX, int targetY, long requestedDeadlineMs) =>
        this.RequestLocalTileTarget(
            "sweep_scythe", requestId, targetX, targetY, $"sweep_scythe_{targetX}_{targetY}", requestedDeadlineMs,
            AdmissionActionabilityProfile.Physical,
            authorize: null,
            gate: _ =>
                ResolveDeclaredTool(Game1.player.Items, "sweep_scythe").RefusalCode is { } toolRefusal
                    ? new TileTargetRefusal(toolRefusal, DescribeDeclaredToolRefusal(Game1.player.Items, "sweep_scythe", toolRefusal))
                    : null,
            inReach: IsTileWithinToolReach,
            execute: (executionId, admittedRequestId) => this.ExecuteSweepScythe(executionId, admittedRequestId, targetX, targetY));

    private LocalExecutionReceipt ExecuteSweepScythe(string executionId, string requestId, int targetX, int targetY)
    {
        if (!TrySelectDeclaredTool(Game1.player, "sweep_scythe", out DeclaredToolSelection selection, out string toolRefusalCode))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, toolRefusalCode, DescribeDeclaredToolRefusal(Game1.player.Items, "sweep_scythe", toolRefusalCode));
        Dictionary<string, string> evidence = ToolActionEvidence.SelectionFacts(selection);
        ExecutionState state;
        string reasonCode;
        try
        {
            if (selection.Tool is not MeleeWeapon weapon || !weapon.isScythe())
            {
                return this.RememberTerminal(
                    requestId,
                    executionId,
                    ExecutionState.Rejected,
                    $"tool_not_selected:{selection.Category}",
                    $"slot={selection.Slot};blocked_by={new RefusalLayerToken(RefusalLayerKind.Tool, selection.Category).Format()}");
            }
            GameLocation location = Game1.player.currentLocation;
            int actorX = (int)Game1.player.Tile.X;
            int actorY = (int)Game1.player.Tile.Y;
            if (SwingFacing.For((actorX, actorY), (targetX, targetY)) is not { } facing)
            {
                return this.RememberTerminal(
                    requestId,
                    executionId,
                    ExecutionState.Rejected,
                    "sweep_needs_cardinal_stance",
                    $"target={targetX},{targetY};actor={actorX},{actorY};facing={Game1.player.FacingDirection.ToString(CultureInfo.InvariantCulture)};blocked_by={new RefusalLayerToken(RefusalLayerKind.Range, "stance").Format()}");
            }

            IReadOnlyList<Vector2> arc = MeleeSweepArc.Sampled(weapon, Game1.player, targetX, targetY, facing);
            Vector2 named = new(targetX, targetY);
            if (!arc.Contains(named))
            {
                return this.RememberTerminal(
                    requestId,
                    executionId,
                    ExecutionState.Rejected,
                    "sweep_arc_misses_target",
                    $"target={targetX},{targetY};arc={MeleeSweepOccupancy.DescribeTiles(arc)}");
            }

            FarmhandForEachFarmWorld world = new(location, MeleeSweepOccupancy.NoActionsEnabled, () => false);
            Dictionary<Vector2, MeleeSweepTile> before = new();
            foreach (Vector2 tile in arc)
                before[tile] = MeleeSweepOccupancy.Read(location, world, tile);
            // THE TILE SHE NAMED IS THE COMPLETION CONDITION, so a tile this swing does not clear is a request that can
            // only come back partial - after a swing the engine's arc aims behind her as well as in front. The occupant
            // and the published action that DOES remove it are named, in that order, inside the Host's model share.
            MeleeSweepTile namedTile = before[named];
            if (!MeleeSweepOccupancy.Sweepable.Contains(namedTile.Occupant))
            {
                return this.RememberTerminal(
                    requestId,
                    executionId,
                    ExecutionState.Rejected,
                    $"{MeleeSweepOccupancy.TargetNotScytheWork}:{namedTile.Occupant}",
                    MeleeSweepOccupancy.DescribeTargetNotScytheWork(namedTile.Occupant, named)
                        + $";blocked_by={new RefusalLayerToken(RefusalLayerKind.Terrain, namedTile.Occupant).Format()}");
            }

            List<(Vector2 Tile, string Kind)> wouldDestroy = MeleeSweepOccupancy.Undeclared(arc, tile => before[tile], named);
            if (wouldDestroy.Count > 0)
            {
                return this.RememberTerminal(
                    requestId,
                    executionId,
                    ExecutionState.Rejected,
                    $"sweep_would_destroy:{wouldDestroy[0].Kind}",
                    $"target={targetX},{targetY};would_destroy={MeleeSweepOccupancy.Describe(wouldDestroy)};arc_tiles={arc.Count.ToString(CultureInfo.InvariantCulture)};blocked_by={new RefusalLayerToken(RefusalLayerKind.Terrain, wouldDestroy[0].Kind).Format()}");
            }

            int sweepable = arc.Count(tile => MeleeSweepOccupancy.Sweepable.Contains(before[tile].Occupant));

            float staminaBefore = Game1.player.Stamina;
            UseNativeMeleeSweep(weapon, location, targetX, targetY, Game1.player, staminaBefore, facing);
            float staminaAfter = Game1.player.Stamina;
            float staminaDelta = staminaAfter - staminaBefore;
            float expectedStaminaCost = 0f;
            Dictionary<Vector2, MeleeSweepTile> after = new();
            foreach (Vector2 tile in arc)
                after[tile] = MeleeSweepOccupancy.Read(location, world, tile);
            List<(Vector2 Tile, string Kind)> changed = MeleeSweepOccupancy.Changes(arc, before, after);
            bool namedMoved = MeleeSweepOccupancy.Changed(before[named], after[named]);
            bool everySweepableMoved = arc
                .Where(tile => MeleeSweepOccupancy.Sweepable.Contains(before[tile].Occupant))
                .All(tile => MeleeSweepOccupancy.Changed(before[tile], after[tile]));            evidence["location"] = location.NameOrUniqueName;
            evidence["target"] = $"{targetX},{targetY}";
            evidence["before_occupant"] = before[named].Occupant;
            evidence["after_occupant"] = after[named].Occupant;
            evidence["named_moved"] = namedMoved.ToString().ToLowerInvariant();
            evidence["arc_tiles"] = arc.Count.ToString(CultureInfo.InvariantCulture);
            evidence["arc_sweepable"] = sweepable.ToString(CultureInfo.InvariantCulture);
            evidence["arc_clear"] = arc
                .Count(tile => string.Equals(before[tile].Occupant, FarmhandForEachHealing.NoOccupant, StringComparison.Ordinal))
                .ToString(CultureInfo.InvariantCulture);
            evidence["changed"] = MeleeSweepOccupancy.Describe(changed);
            evidence["tiles_changed"] = changed.Count.ToString(CultureInfo.InvariantCulture);
            evidence["stamina_before"] = staminaBefore.ToString("0.####", CultureInfo.InvariantCulture);
            evidence["stamina_after"] = staminaAfter.ToString("0.####", CultureInfo.InvariantCulture);
            evidence["stamina_delta"] = staminaDelta.ToString("0.####", CultureInfo.InvariantCulture);
            evidence["expected_stamina_cost"] = expectedStaminaCost.ToString("0.####", CultureInfo.InvariantCulture);
            if (changed.Count == 0)
            {
                state = ExecutionState.Uncertain;
                reasonCode = "sweep_postcondition_unavailable";
            }
            else if (namedMoved && everySweepableMoved)
            {
                state = ExecutionState.Succeeded;
                reasonCode = "scythe_sweep_cut";
            }
            else
            {
                state = ExecutionState.PartiallySucceeded;
                reasonCode = "scythe_sweep_partial";
            }
        }
        finally
        {
            RestoreToolSelection(Game1.player, selection);
            evidence["tool_restored"] = DescribeToolCategory(Game1.player.CurrentTool);
        }
        return this.RememberTerminal(requestId, executionId, state, reasonCode, ToolActionEvidence.Compose(ToolActionEvidence.SweepScythe, evidence));
    }

    private LocalExecutionReceipt ExecuteCutWeeds(string executionId, string requestId, int slot, int targetX, int targetY, string expectedTargetId)
    {
        if (!TrySelectDeclaredTool(Game1.player, "cut_weeds", out DeclaredToolSelection selection, out string toolRefusalCode))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, toolRefusalCode, $"slot={slot}");
        Dictionary<string, string> evidence = ToolActionEvidence.SelectionFacts(selection);
        ExecutionState state;
        string reasonCode;
        try
        {
            if (selection.Tool is not MeleeWeapon weapon)
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, $"tool_not_selected:{selection.Category}", $"slot={selection.Slot}");
            GameLocation location = Game1.player.currentLocation;
            Vector2 tile = new(targetX, targetY);
            if (!location.objects.TryGetValue(tile, out StardewValley.Object? weed) || !weed.IsWeeds()
                || !string.Equals(BuildWeedTargetId(location, targetX, targetY, weed), expectedTargetId, StringComparison.Ordinal))
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "weed_target_changed", $"target={targetX},{targetY}");

            int healthBefore = weed.MinutesUntilReady;
            float staminaBefore = Game1.player.Stamina;
            // A common weed (O)313 carries 2 health and the basic scythe (W)47
            // deals exactly 1 damage per native swing (Object.performToolAction
            // weeds branch: damage = 1, only a non-basic scythe deals 2). One
            // swing therefore never triggers native cutWeed; keep swinging the
            // same equipped scythe on the same object until it is removed, the
            // bounded safety cap is reached, or the weed leaves an unhandled
            // state. Every swing runs the native damage/debris path.
            const int maximumSwingCount = 8;
            ToolStaminaVerdict weedStamina = ToolStaminaGuard.Check(
                Game1.player.Stamina,
                ToolStaminaGuard.PerSwingCharge(Game1.player.FarmingLevel, weapon.IsEfficient) * maximumSwingCount);
            if (!weedStamina.Allowed)
                return this.RememberTerminal(
                    requestId,
                    executionId,
                    ExecutionState.Rejected,
                    weedStamina.ReasonCode,
                    $"target={targetX},{targetY};{weedStamina.Evidence};swings_worst_case={maximumSwingCount}");
            int swingCount = 0;
            bool handled = false;
            bool removed = false;
            while (!removed && swingCount < maximumSwingCount)
            {
                // Native Object.performToolAction weeds branch decrements the
                // weed health only while shakeTimer <= 0 and then arms that 200ms
                // cooldown; the scythe caller (MeleeWeapon.DoFunction AoE sweep)
                // also removes the object from the map only when the action
                // returns true. Mirror both halves of that native swing here:
                // reset the shake cooldown as if the next swing started after it
                // elapsed, call the same native action, and remove the map entry
                // exactly when the native action reports the weed was cut.
                weed.shakeTimer = 0;
                bool cut = weed.performToolAction(weapon);
                swingCount++;
                if (cut)
                {
                    handled = true;
                    location.objects.Remove(tile);
                    removed = true;
                }
                else
                {
                    removed = !location.objects.TryGetValue(tile, out StardewValley.Object? afterWeed)
                        || !ReferenceEquals(afterWeed, weed);
                }
            }
            float staminaAfter = Game1.player.Stamina;
            float staminaDelta = staminaAfter - staminaBefore;
            // The scythe is a MeleeWeapon: no native code path deducts stamina for
            // a melee swing (only Axe/Hoe/Pickaxe/WateringCan/MilkPail/Shears do),
            // so the expected embodied cost is exactly zero. Reporting it as an
            // explicit zero is the fact the Agent needs ("this family is free").
            float expectedStaminaCost = 0f;
            evidence["target"] = expectedTargetId;
            evidence["type"] = "weed";
            evidence["tool"] = "scythe";
            evidence["qualified_item_id"] = weed.QualifiedItemId;
            evidence["health_before"] = healthBefore.ToString(CultureInfo.InvariantCulture);
            evidence["health_after"] = removed
                ? "removed"
                : location.objects.TryGetValue(tile, out StardewValley.Object? remainingWeed) && remainingWeed is not null
                    ? remainingWeed.MinutesUntilReady.ToString(CultureInfo.InvariantCulture)
                    : "missing";
            evidence["swings"] = swingCount.ToString(CultureInfo.InvariantCulture);
            evidence["removed"] = removed.ToString().ToLowerInvariant();
            evidence["stamina_before"] = staminaBefore.ToString("0.####", CultureInfo.InvariantCulture);
            evidence["stamina_after"] = staminaAfter.ToString("0.####", CultureInfo.InvariantCulture);
            evidence["stamina_delta"] = staminaDelta.ToString("0.####", CultureInfo.InvariantCulture);
            evidence["expected_stamina_cost"] = expectedStaminaCost.ToString("0.####", CultureInfo.InvariantCulture);
            (state, reasonCode) = PostconditionVerdict(handled && removed, "weeds_cut", "weed_cut_postcondition_unavailable");
        }
        finally
        {
            RestoreToolSelection(Game1.player, selection);
            evidence["tool_restored"] = DescribeToolCategory(Game1.player.CurrentTool);
        }
        return this.RememberTerminal(requestId, executionId, state, reasonCode, ToolActionEvidence.Compose(ToolActionEvidence.CutWeeds, evidence));
    }

    private static int ItemRankForWeapon(Tool item)
    {
        if (item is MeleeWeapon melee)
            return melee.getItemLevel();
        return item is Slingshot ? 1 : 0;
    }

    /// <summary>
    /// Begins the shared approach leg for a tool-family action whose target is
    /// outside the native interaction radius.
    ///
    /// Why walking is the player-equivalent behaviour and not a Mod convenience:
    /// the native click path gates interaction on the same Chebyshev-1 radius
    /// (<c>Game1.cs:11509</c> requires <c>tileWithinRadiusOfPlayer(grabTile, 1)</c>
    /// before <c>checkAction</c>; <c>GameLocation.cs:14233</c> dims the cursor for a
    /// reachable-but-out-of-range target; <c>Character.GetToolLocation</c>
    /// (<c>:1218-1228</c>) only returns the clicked tile when it is within that
    /// radius, otherwise it swings at the tile in front). A real player therefore
    /// must walk into range; this leg does exactly that.
    ///
    /// The walk uses the arrival predicate with <c>AllowAdjacentArrival: true</c>,
    /// so it stops on any Chebyshev-1 tile and the subsequent tool call re-enters
    /// the same native path a standing player would use. The completion pass in
    /// <see cref="Update"/> re-validates the world (the target may be gone or the
    /// tool may have changed while walking) before executing anything, and reports
    /// the unchanged <c>target_out_of_reach</c> refusal when the walk cannot be
    /// planned at all.
    /// </summary>
    /// <summary>
    /// Begins an approach leg for an action that found itself outside the native interaction radius, and returns the
    /// honest `Accepted` receipt. Works for a target of one tile or of several.
    ///
    /// The action has already validated everything that does not depend on position (its tool, its target identity),
    /// so this owns only the geometry and the ownership bookkeeping. `onArrival` runs later from the completion pass
    /// and mints the action's terminal; it must re-validate, because the walk can take several ticks.
    ///
    /// <para>
    /// <paramref name="footprint"/> is the full occupied tile set and is used for exactly ONE decision: which tile the
    /// actor stands on. The anchor alone was not enough, because a 2x2 clump at (5,5) is worked from (5,7) - the tile
    /// a farmer standing SOUTH of it occupies - and that tile is outside the anchor's eight-neighbour ring, so the
    /// south face was unreachable by construction and the walk went round behind the obstacle.
    /// </para>
    /// <para>
    /// The walk is dispatched to the footprint tile the chosen standing tile reaches, not to the anchor, because
    /// arrival is re-checked against the native Chebyshev-1 interaction radius. From (5,7) the tile reached is (5,6);
    /// measured against the anchor (5,5) the same arrival reads Chebyshev-2 and is refused `target_out_of_reach`
    /// after a walk that landed exactly where it was sent.
    /// </para>
    /// </summary>
    /// <param name="actionId">The wire action id, republished in snapshots.</param>
    /// <param name="noStandingTileCodePrefix">
    /// The caller's own name for "this target has nowhere to stand", when it has one. The verdict, the evidence and the
    /// hint are the leg's either way; only the reason code changes, because `no_reachable_approach:&lt;x&gt;:&lt;y&gt;`
    /// names the PLACEMENT while an action that has just asked the soil question is naming the STANDING tile.
    /// </param>
    private LocalExecutionReceipt TryBeginToolApproach(
        string requestId,
        string executionId,
        string actionId,
        GameLocation location,
        (int X, int Y) anchor,
        System.Collections.Generic.IReadOnlyList<(int X, int Y)> footprint,
        string expectedTargetId,
        Func<string, string, LocalExecutionReceipt> onArrival,
        long nowMs,
        long requestedDeadlineMs,
        string? noStandingTileCodePrefix = null)
    {
        int deadlineTicks = Math.Max(1, (int)Math.Ceiling((requestedDeadlineMs - nowMs) * 60d / 1000d));
        Func<(int X, int Y), bool> isStandable = tile =>
            StardewBodyController.IsStandableTile(location, Game1.player, new Vector2(tile.X, tile.Y))
            && !IsWarpBufferTile(location, tile);
        (int X, int Y) actor = ((int)Game1.player.Tile.X, (int)Game1.player.Tile.Y);
        bool actorOnTarget = footprint.Count == 1 && actor == footprint[0];
        (int X, int Y)? standingTile = SelectToolApproachTile(
            footprint,
            actor,
            isStandable,
            StardewBodyController.BuildWalkableComponent(location, Game1.player) is { } component
                ? tile => component(new Vector2(tile.X, tile.Y))
                : _ => true);
        if (standingTile is null)
        {
            if (actorOnTarget)
            {
                return this.RememberTerminal(
                    requestId,
                    executionId,
                    ExecutionState.Rejected,
                    "hollow_ring_no_step_out",
                    DescribeNoReachableApproach(anchor, actor, isStandable, footprint, location: location, player: Game1.player).Evidence
                        + ";hollow_ring=true;step_out=none"
                        + DescribeApproachRange(footprint[0].X, footprint[0].Y));
            }

            (string refusalCode, string refusalEvidence, string refusalHint) = DescribeNoReachableApproach(
                anchor, actor, isStandable, footprint, noStandingTileCodePrefix, location, Game1.player);
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, refusalCode, refusalEvidence + DescribeApproachRange(targetX: anchor.X, targetY: anchor.Y, standingTileAsked: noStandingTileCodePrefix is not null), hint: refusalHint);
        }
        (int X, int Y) goal = standingTile.Value;
        (int X, int Y) reach = footprint.Count == 1 ? footprint[0] : SelectReachTile(footprint, goal);
        int targetX = reach.X;
        int targetY = reach.Y;
        LocalMoveSpec approach = new(
            executionId,
            requestId,
            new Vector2(goal.X, goal.Y),
            false,
            this.revision,
            this.tick + deadlineTicks,
            requestedDeadlineMs);
        this.slots.ToolApproach.Assign(new LocalApproachSpec(
            executionId,
            requestId,
            actionId,
            location.NameOrUniqueName,
            targetX,
            targetY,
            expectedTargetId,
            onArrival,
            this.revision,
            requestedDeadlineMs));
        this.slots.Active.Assign(approach);
        if (!this.controller.TryStart(approach, Game1.player, this.tick, out string reasonCode, out string? approachEvidence))
        {
            this.slots.Active.Clear();
            this.slots.ToolApproach.Clear();
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                reasonCode == "no_native_path" ? "target_out_of_reach" : reasonCode,
                approachEvidence ?? $"target={targetX},{targetY};reach=1");
        }

        string distance = ChebyshevDistance(Game1.player, targetX, targetY).ToString(CultureInfo.InvariantCulture);
        string reached = footprint.Count == 1
            ? string.Empty
            : $";anchor={anchor.X},{anchor.Y};reached=footprint";
        string steppedOut = actorOnTarget
            ? $";stepped_out_from={actor.X},{actor.Y};stepped_out_to={goal.X},{goal.Y}"
            : string.Empty;
        return this.RememberTerminal(
            requestId,
            executionId,
            ExecutionState.Accepted,
            "accepted",
            $"location={location.NameOrUniqueName};target={expectedTargetId};tile={targetX},{targetY};distance={distance};reach=1;approach=adjacent;stand_at={goal.X},{goal.Y}{reached}{steppedOut}");
    }

    private LocalExecutionReceipt TryBeginToolApproach(
        string requestId,
        string executionId,
        string actionId,
        GameLocation location,
        int targetX,
        int targetY,
        string expectedTargetId,
        Func<string, string, LocalExecutionReceipt> onArrival,
        long nowMs,
        long requestedDeadlineMs,
        string? noStandingTileCodePrefix = null) =>
        this.TryBeginToolApproach(
            requestId,
            executionId,
            actionId,
            location,
            (targetX, targetY),
            new[] { (targetX, targetY) },
            expectedTargetId,
            onArrival,
            nowMs,
            requestedDeadlineMs,
            noStandingTileCodePrefix);

    private static string DescribeApproachRange(int targetX, int targetY, bool standingTileAsked = false)
    {
        string detail = standingTileAsked || IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1)
            ? "standability"
            : $"reach:{ChebyshevDistance(Game1.player, targetX, targetY).ToString(CultureInfo.InvariantCulture)}";
        return $";blocked_by={new RefusalLayerToken(RefusalLayerKind.Range, detail).Format()}";
    }

    private void CompleteToolApproach(LocalApproachSpec specification)
    {
        this.slots.ToolApproach.Clear();

        GameLocation? location = Game1.player.currentLocation;
        bool sameLocation = location is not null
            && string.Equals(location.NameOrUniqueName, specification.Location, StringComparison.Ordinal);
        if (!sameLocation)
        {
            this.revision++;
            LocalExecutionReceipt moved = new(specification.ExecutionId, specification.RequestId, ExecutionState.Rejected, "tool_approach_location_changed", this.revision,
                $"target={specification.ExpectedTargetId};expected={specification.Location};actual={location?.NameOrUniqueName ?? "none"}");
            this.ledger.Remember(moved);
            this.AddTrace(moved);
            this.ledger.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
            return;
        }

        if (!IsTileWithinChebyshevRadius(Game1.player, specification.TargetX, specification.TargetY, 1))
        {
            this.revision++;
            LocalExecutionReceipt short_ = new(specification.ExecutionId, specification.RequestId, ExecutionState.Rejected, "target_out_of_reach", this.revision,
                $"target={specification.TargetX},{specification.TargetY};distance={ChebyshevDistance(Game1.player, specification.TargetX, specification.TargetY).ToString(CultureInfo.InvariantCulture)};reach=1;approach=did_not_arrive");
            this.ledger.Remember(short_);
            this.AddTrace(short_);
            this.ledger.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
            return;
        }

        if (IsToolTargetUnderActor(Game1.player, specification.TargetX, specification.TargetY))
        {
            this.revision++;
            LocalExecutionReceipt unmoved = new(specification.ExecutionId, specification.RequestId, ExecutionState.Rejected, "hollow_ring_step_out_failed", this.revision,
                $"target={specification.TargetX},{specification.TargetY};tile={FormatTile(Game1.player.Tile)};reach=1;approach=did_not_arrive;hollow_ring=true;step_out=failed");
            this.ledger.Remember(unmoved);
            this.AddTrace(unmoved);
            this.ledger.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
            return;
        }

        _ = specification.Execute(specification.ExecutionId, specification.RequestId);
    }

}

/// <summary>What one action's pack answers for its declared tool, before anything is switched.</summary>
internal readonly record struct DeclaredToolResolution(string Category, int Slot, string? RefusalCode, int OwnedUpgrade = -1)
{
    /// <summary>
    /// The layer detail a refusal of this claim carries on `blocked_by`: the tool CATEGORY the action's own row named.
    ///
    /// <para>
    /// Derived here, beside the resolution that decides it, rather than at each refusal site - the category and the
    /// refusal code are two readings of one decision, and a call site that composed its own detail would be the second
    /// copy this Mod keeps rediscovering. `undeclared` is the honest detail when a handler asked for a claim its own row
    /// does not carry: that is a registration defect, not something the world is missing.
    /// </para>
    /// </summary>
    internal string? RefusalDetail => this.RefusalCode is null
        ? null
        : this.Category.Length > 0 ? this.Category : "undeclared";
}

/// <summary>
/// The actor's tool selection while one action runs: the tool taken, the category it satisfies, the index it
/// replaced, and the tool that index held - which is what every exit restores and what the receipt reports.
/// </summary>
internal readonly record struct DeclaredToolSelection(Tool Tool, string Category, int Slot, int PreviousSlot, Tool? PreviousTool);

/// <summary>
/// What one `<c>Pickaxe.DoFunction</c> call on a breakable stone achieved.
///
/// <para>
/// The swing subtracts `Math.Max(1, upgradeLevel + 1) + additionalPower` from the rock's `MinutesUntilReady`
/// (`Pickaxe.cs:139-140`) and returns early while the remainder is positive (`Pickaxe.cs:142-146`); only a durability
/// that reaches zero takes the object out of the layer (`Pickaxe.cs:169-178`). So the engine gives exactly two ways to
/// have made progress — the rock got weaker, or the rock is gone — and either is a completed dispatch. Anything else
/// means the swing did not land on the source this action was pointed at.
/// </para>
/// </summary>
internal static class RockSourceSwing
{
    internal static bool MadeProgress(int durabilityBefore, int? durabilityAfter) =>
        durabilityAfter is null || durabilityAfter.Value < durabilityBefore;
}

/// <summary>
/// The receipt-detail key set of each tool action, stated ONCE per action.
///
/// The Host pins every one of these sets EXACTLY (`host/src/stardew-game-integration-adapter.ts`: the `cut_weeds` and
/// `cut_grass` branches, `hasWaterCropCompletionEvidence`, `hasBreakRockSourceCompletionEvidence`), so a success with
/// an unexpected key - or without one - is a success the Host does not recognise.
///
/// The tool-selection keys are written by the side that performs the fact: `ToolActionEvidence.SelectionFacts` states
/// what the handler took while that tool is in hand, and `tool_restored` is written only after
/// `RestoreToolSelection` has actually run. A run that dies between the two emits no `tool_restored` rather than
/// claiming a restore it did not perform.
/// </summary>
internal static class ToolActionEvidence
{
    internal static readonly IReadOnlyList<string> CutWeeds = Array.AsReadOnly(new[]
    {
        "target", "type", "tool", "tool_selected", "slot", "tool_before", "slot_before", "qualified_item_id",
        "health_before", "health_after", "swings", "removed", "stamina_before", "stamina_after", "stamina_delta",
        "expected_stamina_cost", "tool_restored",
    });

    internal static readonly IReadOnlyList<string> CutGrass = Array.AsReadOnly(new[]
    {
        "target", "type", "tool", "tool_selected", "slot", "tool_before", "slot_before", "grass_type",
        "weeds_before", "weeds_after", "swings", "removed", "tuft_removed", "stamina_before", "stamina_after",
        "stamina_delta", "expected_stamina_cost", "tool_restored",
    });

    /// <summary>
    /// sweep_scythe's detail, declared ONCE and compared against the Host's own copy by
    /// `DeclaredToolSelectionTests.EveryToolActionStillPublishesExactlyTheEvidenceKeysTheHostPins`.
    ///
    /// <para>
    /// `arc_tiles`/`arc_sweepable`/`arc_clear` describe the arc the engine's own six rectangles sampled: how many tiles
    /// it held, how many of them carried something a scythe cuts, and how many carried nothing at all. Unlike the charged
    /// tools' `window`, this box is not a superset - it is the exact set the engine samples - so "already clear" is a
    /// measurement here rather than a class the Mod cannot tell apart. `changed` names the tiles that MOVED, each with
    /// what stood there before the swing, because after a successful cut the tile is empty and the kind would otherwise
    /// be unrecoverable. Nothing about hits, kills or projectiles is published: six `DoDamage` evaluations are not
    /// vanilla's seven and a combat claim would describe a swing the engine did not exactly perform.
    /// </para>
    /// </summary>
    internal static readonly IReadOnlyList<string> SweepScythe = Array.AsReadOnly(new[]
    {
        "location", "target", "before_occupant", "after_occupant", "named_moved", "arc_tiles", "arc_sweepable",
        "arc_clear", "changed", "tiles_changed", "tool_selected", "slot", "tool_before", "slot_before",
        "stamina_before", "stamina_after", "stamina_delta", "expected_stamina_cost", "tool_restored",
    });

    internal static readonly IReadOnlyList<string> BreakRockSource = Array.AsReadOnly(new[]
    {
        "target", "tool", "tool_selected", "slot", "tool_before", "slot_before", "qualified_item_id",
        "durability_before", "durability_after", "removed", "stamina_before", "stamina_after", "stamina_delta",
        "expected_stamina_cost", "tool_restored",
    });

    internal static readonly IReadOnlyList<string> WaterCrop = Array.AsReadOnly(new[]
    {
        "location", "target", "tile", "tool_selected", "slot", "tool_before", "slot_before", "before_watered",
        "after_watered", "water_before", "water_after", "water_consumed", "water_expected_cost",
        "charge_requested", "charge_applied", "window", "tiles_changed", "changed", "stamina_before", "stamina_after",
        "stamina_delta", "expected_stamina_cost", "tool_restored",
    });

    internal static readonly IReadOnlyList<string> BreakResourceClump = Array.AsReadOnly(new[]
    {
        "location", "target", "tile", "parent", "required_upgrade", "tool", "tool_selected", "slot",
        "tool_before", "slot_before", "health_before", "health_after", "swings", "clump_removed", "drop_observed",
        "stamina_before", "stamina_after", "stamina_delta", "expected_stamina_cost", "tool_restored",
    });

    internal static readonly IReadOnlyList<string> TillSoil = Array.AsReadOnly(new[]
    {
        "location", "target", "tool_selected", "slot", "tool_before", "slot_before", "before", "after",
        "charge_requested", "charge_applied", "window", "tiles_changed", "changed", "stamina_before",
        "stamina_after", "stamina_delta", "expected_stamina_cost", "tool_restored",
    });

    /// <summary>
    /// The selection half of one action's detail: the tool the handler took, the slot it came from, and the tool and
    /// slot it displaced. `slot` is the one the SELECTION put in hand, never the number a request carried.
    /// </summary>
    internal static Dictionary<string, string> SelectionFacts(DeclaredToolSelection selection) => new()
    {
        ["tool_selected"] = selection.Category,
        ["slot"] = selection.Slot.ToString(CultureInfo.InvariantCulture),
        ["tool_before"] = ExecutionManager.DescribeToolCategory(selection.PreviousTool),
        ["slot_before"] = selection.PreviousSlot.ToString(CultureInfo.InvariantCulture),
    };

    internal static string SelectionSuffix(DeclaredToolSelection selection, string restoredCategory) =>
        string.Join(";", SelectionFacts(selection).Select(fact => $"{fact.Key}={fact.Value}"))
        + $";tool_restored={restoredCategory}";

    /// <summary>
    /// One receipt detail from a key list and its values, in the LIST's order: the list is the contract, so a key that
    /// has no value fails here instead of reaching the wire as a half-built detail.
    /// </summary>
    internal static string Compose(IReadOnlyList<string> keys, IReadOnlyDictionary<string, string> values) =>
        string.Join(";", keys.Select(key => $"{key}={values[key]}"));
}
