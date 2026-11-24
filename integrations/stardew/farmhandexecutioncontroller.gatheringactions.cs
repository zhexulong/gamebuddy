using System.Globalization;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Navigation;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Tools;
using StardewValley.Characters;

namespace GameBuddy.Stardew;

internal sealed partial class ExecutionManager
{
    private const int ItemPickupMagnetClaimTicks = 60 * 60 * 5;

    /// <summary>
    /// The catalogue's id for this family's forage pickup, spelled once: the approach leg names the action it walks for
    /// and the verdict names the action it settles, and two spellings of that id would let the receipt answer for one
    /// action while the leg walked for another.
    /// </summary>
    internal const string ForagePickupActionId = "pickup_forage";

    /// <summary>
    /// How many of this Mod's own updates the engine's magnet may have to deliver a ground chunk before the wait is
    /// settled. Not the catalogue's watchdog, which bounds liveness for every action and stays where it is.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Reading the engine's own path rather than guessing: a chunk may not move until <c>timeSinceDoneBouncing</c>
    /// reaches 600 ms (Debris.cs:636-637), it then travels at most 0.8 px per axis per update with the ramp capped at 8
    /// (Debris.cs:760-778), and it is collected only once its centre is inside 64 px per axis of the body's standing
    /// pixel (Debris.cs:779-783, then <c>farmer.addItemToInventoryBool(item)</c> at :485 and the chunk leaving
    /// <c>Chunks</c> at :793). So the worst case is the 600 ms of settling - 36 updates at the game's 60 per second -
    /// plus the 13 the ramp needs to close the last 64 px of a 128 px reach: about 50 updates. 120 is that budget with
    /// the same kind of margin the pedestal's mutex window gives its own hand-over, and because it counts UPDATES a
    /// slower machine only lengthens it in seconds, never shortens it in fairness.
    /// </para>
    /// <para>
    /// The silence it replaces was measured across one receipt channel (269 <c>pickup_item</c> executions): p50 0 ms,
    /// p95 3.3 s, and nine at 59.8-60.0 s - those nine were waiting for the watchdog, not for the magnet.
    /// </para>
    /// </remarks>
    internal const int ItemPickupMagnetWindowTicks = 120;

    private string? itemPickupMagnetExecutionId;
    private long itemPickupMagnetStartedTick;

    private int ItemPickupMagnetTicks(string executionId)
    {
        if (!string.Equals(this.itemPickupMagnetExecutionId, executionId, StringComparison.Ordinal))
        {
            this.itemPickupMagnetExecutionId = executionId;
            this.itemPickupMagnetStartedTick = this.tick;
        }

        return (int)(this.tick - this.itemPickupMagnetStartedTick);
    }

    /// <summary>
    /// Published native forage pickup. The native location action owns inventory and object removal.
    ///
    /// <para>
    /// OUT OF THE NATIVE RANGE THE ACTOR WALKS IN. <c>Utility.tileWithinRadiusOfPlayer(tile, 1)</c> is not this action's
    /// rule - it is the engine's own guard on the click path (<c>Game1.cs:11509</c> requires it before
    /// <c>checkAction</c>, which is what <c>Game1.tryToCheckAt</c> runs), so a player picking up a daffodil walks to it
    /// first and clicks. The request path used to answer that distance with <c>forage_target_out_of_range</c> instead,
    /// which is the refusal a walk belongs in: measured `round65`, the only failure class in the whole run was four of
    /// them, and one lily was never picked. The walk is the one every other gathering action already takes
    /// (<see cref="TryBeginToolApproach"/>), so the radius now decides WHETHER TO WALK, never whether to answer.
    /// </para>
    /// </summary>
    public LocalExecutionReceipt RequestLocalPickupForage(string requestId, int targetX, int targetY, string expectedQualifiedItemId, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = this.ledger.NewExecutionId(requestId);
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (!this.TryGetBoundActor(out Farmer? boundActor, out string scopeReason) || boundActor is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, scopeReason, null);

        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;
        // SHE NAMES THE TILE, THE EXECUTOR NAMES THE FORAGE (`round99`). The identity used to be a value only the
        // snapshot could carry, so past its six-tile window there was no way to ask at all; the live object is the one that
        // will be clicked, so it is also the one that can answer.
        bool resolvedAtExecution = string.IsNullOrWhiteSpace(expectedTargetId);
        if (resolvedAtExecution)
        {
            if (!TryMintTileTargetAtExecution(ForagePickupActionId, Game1.player.currentLocation, targetX, targetY, out string minted, out TileTargetRefusal unnamed))
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, unnamed.ReasonCode, unnamed.Evidence);
            expectedTargetId = minted;
        }
        if (!Utility.tileWithinRadiusOfPlayer(targetX, targetY, 1, Game1.player))
            return this.TryBeginToolApproach(
                requestId,
                executionId,
                ForagePickupActionId,
                Game1.player.currentLocation,
                targetX,
                targetY,
                expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecutePickupForage(arrivalExecutionId, arrivalRequestId, targetX, targetY, expectedQualifiedItemId, expectedTargetId, requestedDeadlineMs, resolvedAtExecution),
                nowMs,
                requestedDeadlineMs);

        return this.ExecutePickupForage(executionId, requestId, targetX, targetY, expectedQualifiedItemId, expectedTargetId, requestedDeadlineMs, resolvedAtExecution);
    }

    /// <summary>
    /// The terminal half of <c>pickup_forage</c>: the same body, run either in place or on arrival from the approach leg,
    /// so the two paths cannot drift apart.
    ///
    /// <para>
    /// THE ITEM BEING GONE IS ITS OWN ENDING. A walk takes ticks, and a forageable can leave the tile in that time - a
    /// hoed-up daffodil, a second actor, a season change. `target_not_found` says the published target no longer exists,
    /// which a caller answers by observing again; `forage_target_unavailable` says the tile holds something that answers
    /// neither its published item nor its published id, which is a different correction. Collapsing them into one code
    /// was invisible while nothing walked: the same tick that read the target also picked it up.
    /// </para>
    /// <para>
    /// THE VERDICT IS THREE FACTS AND ONLY TWO OF THEM ARE CONSEQUENCES, so the receipt names all three plus the
    /// container they were read from (<see cref="ForagePickupPostcondition"/>). `Game1.tryToCheckAt` is the engine's own
    /// click path, and `removed`/`inventory_after` are what it did - so a receipt that publishes only those two says
    /// "nothing happened" without saying whether the engine declined or handled it and delivered nothing.
    /// </para>
    ///
    /// <para>
    /// THE OBJECT'S OWN GATES ARE READ BEFORE THE CLICK AND THE CONSEQUENCES AFTER IT, and the receipt says so. `Type`
    /// and `IsSpawnedObject` are what <c>GameLocation.checkAction</c> asks before its forage branch runs at all
    /// (:7727 `value.Type != null || isErrorItem`, :7791 `value.isSpawnedObject.Value || isErrorItem`), so they are the
    /// state OF THE OBJECT THE CLICK WILL READ and are sampled while it is still that object; `removed` and
    /// `inventory_after` are the branch's consequences and are sampled once the call has returned - which for THIS
    /// action is after the mutation, because the branch fills the pack and removes the object inside the same call
    /// (:7830 `addItemToInventoryBool`, :7837 `objects.Remove`, :7838 `return true`). The pair therefore cannot be a
    /// race, and <see cref="ForagePickupPostcondition.ReadPoint"/> says so in the sentence.
    /// </para>
    /// </summary>
    private LocalExecutionReceipt ExecutePickupForage(string executionId, string requestId, int targetX, int targetY, string expectedQualifiedItemId, string expectedTargetId, long requestedDeadlineMs, bool resolvedAtExecution)
    {
        StardewValley.GameLocation? location = Game1.player.currentLocation;
        if (location is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);

        Vector2 tile = new(targetX, targetY);
        if (!location.objects.TryGetValue(tile, out StardewValley.Object? forage))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_not_found",
                $"target={targetX},{targetY};expected={expectedQualifiedItemId};actual=none");
        if (!forage.isForage()
            || !string.Equals(forage.QualifiedItemId, expectedQualifiedItemId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "forage_target_unavailable",
                $"target={targetX},{targetY};expected={expectedQualifiedItemId};actual={forage.QualifiedItemId};is_forage={(forage.isForage() ? "true" : "false")};blocked_by={new RefusalLayerToken(RefusalLayerKind.ObjectOnTile, "different_object").Format()}");
        // THE IDENTITY IS COMPARED APART FROM THE ITEM, and BOTH SIDES ARE PRINTED: the same forageable item is one object,
        // and a tile that now holds a different one of the same item is `forage_target_changed:<expected>:<found>` - the
        // answer that sends the caller to look again, not the item refusal above that tells it the tile is something else.
        string liveTargetId = BuildForageTargetId(location, targetX, targetY, forage);
        if (!string.Equals(liveTargetId, expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "forage_target_changed",
                $"target={targetX},{targetY};expected={expectedTargetId};found={liveTargetId};item={forage.QualifiedItemId};blocked_by={new RefusalLayerToken(RefusalLayerKind.ObjectOnTile, "different_identity").Format()}");
        if (!Game1.player.couldInventoryAcceptThisItem(forage))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "inventory_full", $"target={targetX},{targetY};item={forage.QualifiedItemId}");

        // The two fields the engine's own forage branch opens with, read here while they are still the object's answer.
        bool spawned = forage.IsSpawnedObject;
        string? objectType = forage.Type;
        int beforeCount = Game1.player.Items.Sum(item => item?.QualifiedItemId == expectedQualifiedItemId ? item.Stack : 0);
        LocalForagePickupSpec specification = new(executionId, requestId, location.NameOrUniqueName, targetX, targetY, expectedTargetId, expectedQualifiedItemId, this.revision, requestedDeadlineMs);
        bool actionHandled = Game1.tryToCheckAt(tile, Game1.player);
        int afterCount = Game1.player.Items.Sum(item => item?.QualifiedItemId == expectedQualifiedItemId ? item.Stack : 0);
        ForagePickupPostcondition outcome = new(
            ActionHandled: actionHandled,
            Removed: !location.objects.ContainsKey(tile),
            InventoryBefore: beforeCount,
            InventoryAfter: afterCount,
            Spawned: spawned,
            ObjectType: objectType);
        return this.RememberTerminal(
            requestId,
            executionId,
            outcome.State,
            outcome.ReasonCode,
            $"{outcome.Describe(specification.Location, specification.TargetId, targetX, targetY, expectedQualifiedItemId)};{DescribeTargetIdentity("pickup_forage", resolvedAtExecution)}");
    }

    /// <summary>
    /// The published ground drop, collected through the engine's own magnet.
    ///
    /// <para>
    /// THE EXECUTOR RE-RESOLVES THE TILE, SO THE CALLER NEVER HAS TO. A chunk's opaque identity
    /// (<see cref="BuildItemTargetId"/>) carries no coordinate: the request's <c>x, y</c> is only where the caller SAW
    /// the drop, never where it is. And the engine moves it in between - <c>Debris.updateChunks</c> drags a chunk along
    /// with any Farmer whose magnet holds it (Debris.cs:760-778), and mining scatters the rest. Measured `round77`:
    /// <c>item_target_moved</c> 18 times in 500 real actions, each one a drop that had trailed the companion and was
    /// now beside it while the plan still named the tile it had left. The old body answered that with a refusal past a
    /// three-tile `ChunkDriftTolerance` - a number no engine fact justifies - and then handed
    /// <see cref="MagneticPickupReach.SelectStandTile"/> the LIVE tile anyway, so it was asking the caller to re-observe
    /// a drop the executor was already holding. The live chunk is the same chunk: this body acts on the tile it reports
    /// now and says both tiles in the receipt.
    /// </para>
    ///
    /// <para>
    /// A DROP THAT IS NO LONGER ON THE GROUND HAS THREE NAMES, and they must not collapse into one:
    /// <c>item_picked_up</c> when this actor's own count rose by the stack that was published with the chunk still
    /// lying there (the engine's magnet delivered it - the caller must NOT retry), <c>item_target_changed</c> when a
    /// DIFFERENT chunk of the same item lies on the named tile (retrying is wrong, re-observing is right), and
    /// <c>item_target_gone</c> when no chunk of that identity is anywhere here and nothing arrived (another farmer, a
    /// chest, a shipping bin). &quot;It moved&quot; is not among them any more, because a moved drop is this action's
    /// normal case.
    /// </para>
    /// </summary>
    public LocalExecutionReceipt RequestLocalPickupItem(string requestId, int targetX, int targetY, string expectedQualifiedItemId, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.BeginGuardedLocalExecution(requestId, out Farmer boundActor, out string executionId, out long nowMs) is LocalExecutionReceipt guardRefusal)
            return guardRefusal;
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        StardewValley.GameLocation location = Game1.player.currentLocation;
        // SHE NAMES THE TILE, THE EXECUTOR NAMES THE DROP. A ground chunk's identity embeds the chunk it was minted from,
        // and a plan that walked twenty tiles to a drop has no reading to copy - the live tile is the only place the
        // answer can come from, and it is read here, before the walk buys anything.
        bool resolvedAtExecution = string.IsNullOrWhiteSpace(expectedTargetId);
        if (resolvedAtExecution)
        {
            if (!TryMintTileTargetAtExecution("pickup_item", location, targetX, targetY, out string minted, out TileTargetRefusal unnamed))
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, unnamed.ReasonCode, unnamed.Evidence);
            expectedTargetId = minted;
        }
        (Debris Debris, int DebrisIndex, int ChunkIndex, Chunk Chunk, string TargetId, string QualifiedItemId, int Stack)? target =
            FindItemTarget(location, expectedTargetId, expectedQualifiedItemId);
        if (target is null)
        {
            // The delivery is asked FIRST: the named chunk can be in the pack while a DIFFERENT chunk of the same item
            // lies on the named tile, and `item_target_changed` would then send the caller back to re-observe a drop it
            // is already carrying.
            if (this.TrySettleMagnetCollectedItem(requestId, executionId, boundActor, location, expectedTargetId, expectedQualifiedItemId, targetX, targetY) is LocalExecutionReceipt collected)
                return collected;
            if (FindChunkOnTile(location, targetX, targetY, expectedQualifiedItemId) is { } changed)
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_target_changed", $"expected={expectedTargetId};actual={changed.TargetId};tile={targetX},{targetY}");
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_target_gone",
                $"expected={expectedTargetId};item={expectedQualifiedItemId};tile={targetX},{targetY};location={location.NameOrUniqueName};actual=none");
        }
        // The request's tile is where the caller SAW the drop; the chunk reports where it is now, and that is the tile
        // this body walks to, stands within and lets the magnet collect from.
        Point liveTargetTile = GetChunkTile(target.Value.Chunk);
        if (!Game1.player.couldInventoryAcceptThisItem(target.Value.Debris.item ?? ItemRegistry.Create(expectedQualifiedItemId, target.Value.Stack)))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "inventory_full", $"target={expectedTargetId}");

        int magnetRadius = MagneticPickupReach.ReachPixels(Game1.player);
        Vector2 magnetSubject = MagneticPickupReach.Subject(target.Value.Debris);
        (int X, int Y) actorTile = ((int)Game1.player.Tile.X, (int)Game1.player.Tile.Y);
        // WHY THIS WALK IS NOT THE SHARED APPROACH LEG - judged, because the capability matrix reports this as the one
        // reach-leg action naming none of the three. The shared leg (`TryBeginToolApproach` -> `CompleteToolApproach`) is
        // built from two facts, and this action's are different ones:
        //   * WHAT DECIDES THE STAND TILE. `Debris.playerInRange` (Debris.cs:582-595) is a PIXEL rectangle of
        //     `farmer.GetAppliedMagneticRadius()` around the body's standing pixel, re-asked on every update (:678). The
        //     shared leg answers `IsTileWithinChebyshevRadius(..., 1)` around the target tile instead, which is the
        //     narrower spelling of one reach: a chunk can lie where nobody can stand - a rock-pool edge, a doorway, the
        //     tile under an object - and still be collectable from the tile beside it. `MagneticPickupReach`'s own
        //     remarks record what the tile rule cost (`no_native_path`, `no_reachable_approach`, `item_target_moved` for
        //     chunks that had not moved), so migrating this walk would reintroduce that defect rather than remove one.
        //   * WHAT SETTLES THE REQUEST. There is no arrival execute to hand the leg: `Debris.updateChunks` collects the
        //     chunk itself, on its own update, once the body is inside that rectangle (:652-655, delivered by
        //     `addItemToInventoryBool` at :485, the chunk leaving `Chunks` at :793). The frame loop settles on the engine's
        //     own facts - the chunk gone with the stack in the pack, `BrokenItemPickupPrecondition` naming which of the
        //     engine's two guards the body no longer satisfies, or the bounded magnet window - so an arrival execute would
        //     be a second authority over a write already performed.
        // The TRAVEL is not bespoke: it is the shared movement primitive (`LocalMoveSpec` + `this.controller.TryStart`),
        // and `RecordControllerTransition` keeps the pickup seat alive when the walk ends. The exception is the stand-tile
        // geometry and the settlement. It DISAPPEARS if drop collection ever becomes tile-shaped - the engine gating
        // collection on a tile distance, which would make the ring and an arrival execute the right rule - and it dies
        // mechanically the moment this handler names one of the three legs, because the matrix's no-leg entry then fails.
        MagneticStandSearch reach = MagneticPickupReach.WithinMagnet(magnetSubject, Game1.player.StandingPixel, magnetRadius)
            ? MagneticStandSearch.AlreadyInReach(actorTile)
            : MagneticPickupReach.SelectStandTile(
                magnetSubject,
                actorTile,
                magnetRadius,
                tile => StardewBodyController.IsStandableTile(location, Game1.player, new Vector2(tile.X, tile.Y))
                    && !IsWarpBufferTile(location, tile),
                StardewBodyController.BuildWalkableComponent(location, Game1.player) is { } walkable
                    ? tile => walkable(new Vector2(tile.X, tile.Y))
                    : _ => true);
        // THE REFUSAL PUBLISHES THE GEOMETRY IT ASKED, because its two answers need different repairs and the sentence
        // must not have to be believed. `subject_px` is the point the engine's rectangle is built on
        // (`Debris.approximatePosition`, the debris' mean - NOT the chunk's tile), `subject_centre_px` is the point it is
        // actually COMPARED at (`playerInRange` adds the half-tile, Debris.cs:590), `in_reach` is how many tiles that
        // rectangle covered with `standable`/`reachable` splitting them, `nearest` is the tile that came closest,
        // `nearest_why` is the layer that refuses that tile and `blocked_by` names the search's own predicate. Measured
        // `round80`: seven refusals in one burst, all `stand_at=none`, none of them saying which.
        if (reach.Tile is not { } standTile)
        {
            // The point `Debris.playerInRange` compares: it adds the half tile to the mean before it measures, so a
            // reader subtracting `subject_px` from a standing pixel is 32 px short of the engine's own number.
            Vector2 compared = MagneticPickupReach.SubjectCentre(magnetSubject);
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_target_out_of_reach",
                $"tile={liveTargetTile.X},{liveTargetTile.Y};actor={actorTile.X},{actorTile.Y};radius={magnetRadius};"
                    + $"subject_px={(int)magnetSubject.X},{(int)magnetSubject.Y};subject_centre_px={(int)compared.X},{(int)compared.Y};"
                    + $"{reach.Describe()};nearest_why={DescribeStandRefusal(location, Game1.player, actorTile, reach.NearestRefused)}"
                    + $";blocked_by={new RefusalLayerToken(RefusalLayerKind.Range, reach.RefusalDetail).Format()}");
        }

        int beforeCount = CountQualifiedItem(Game1.player, expectedQualifiedItemId);
        int deadlineTicks = Math.Max(1, (int)Math.Ceiling((requestedDeadlineMs - nowMs) * 60d / 1000d));
        string magnetFacts = $"within_magnet=true;radius={magnetRadius};{reach.Describe()}";
        this.slots.ItemPickup.Assign(new LocalItemPickupSpec(executionId, requestId, location.NameOrUniqueName, liveTargetTile.X, liveTargetTile.Y, expectedTargetId, expectedQualifiedItemId, target.Value.Stack, beforeCount, this.revision, requestedDeadlineMs, TargetIdSource(resolvedAtExecution)));
        if (standTile != actorTile)
        {
            LocalMoveSpec approach = new(executionId, requestId, new Vector2(standTile.X, standTile.Y), false, this.revision, this.tick + deadlineTicks, requestedDeadlineMs);
            this.slots.Active.Assign(approach);
            if (!this.controller.TryStart(approach, Game1.player, this.tick, out string reasonCode, out string? approachEvidence))
            {
                this.slots.Active.Clear();
                this.slots.ItemPickup.Clear();
                string magnetRefusal = $"target={expectedTargetId};{magnetFacts}";
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, reasonCode,
                    approachEvidence is null ? magnetRefusal : $"{approachEvidence};{magnetRefusal}");
            }
        }

        return this.RememberTerminal(requestId, executionId, ExecutionState.Accepted, "accepted",
            $"location={location.NameOrUniqueName};target={expectedTargetId};{DescribeTargetIdentity("pickup_item", resolvedAtExecution)};tile={liveTargetTile.X},{liveTargetTile.Y};named_tile={targetX},{targetY};item={expectedQualifiedItemId};stack={target.Value.Stack};inventory_before={beforeCount};native_auto_collect=true;{magnetFacts}");
    }

    /// <summary>
    /// Which of the engine's own pickup preconditions this body no longer satisfies, or <see langword="null"/> when
    /// the wait it is in still has a way to end.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <c>Debris.updateChunks</c> re-asks two things about a waiting chunk on EVERY game update: whether the body is
    /// still inside the pixel rectangle <c>playerInRange</c> reads (Debris.cs:582-595, re-asked at :678) and whether
    /// this farmer's pack will take the item (:732-744). The bridge asked the first of those once, when the request
    /// arrived - so a chunk that slid while she walked, or a body that finished its walk a pixel outside the rectangle,
    /// was never re-tested and the action waited out its whole deadline with nothing left that could happen.
    /// </para>
    /// <para>
    /// The engine's other two guards - <c>shouldControlThis</c> (Debris.cs:621-628) and <c>IsLocalPlayer</c> (:758) -
    /// are topology rather than a condition that can change while one request is being served, so they are answered at
    /// admission and not re-asked here. The bounce timer (:636-637) is a wait, not a refusal: it is what
    /// <c>ItemPickupMagnetWindowTicks</c> bounds.
    /// </para>
    /// <para>
    /// THE DISTANCE IT ASKS IS THE DISTANCE THE RECEIPT PRINTS, from the same owner: <c>playerInRange</c> adds the half
    /// tile before it compares (Debris.cs:590, <c>position.X + 32f - standingPixel.X</c>), and `round81` read
    /// <c>subject_px</c> - 32 px short of the point the engine measures - as a guard refusing inside its own radius.
    /// <see cref="MagneticPickupReach.AxisDistance"/> is that subtraction, <see cref="MagneticPickupReach.WithinMagnet"/> is
    /// the engine's <c>&lt;=</c> over it and <c>axis_distance_px</c> is the same two numbers, so neither half can drift
    /// from the engine.
    /// </para>
    /// </remarks>
    private static string? BrokenItemPickupPrecondition(Farmer actor, Debris debris)
    {
        if (!MagneticPickupReach.InReach(actor, debris))
            return "player_in_range";
        bool acceptsTheDrop = debris.item is { } held
            ? actor.couldInventoryAcceptThisItem(held)
            : actor.couldInventoryAcceptThisItem(debris.itemId.Value, 1, debris.itemQuality);
        return acceptsTheDrop ? null : "inventory_full";
    }

    /// <summary>
    /// What refuses the tile the search came closest to and could not use, in the one layer vocabulary, or `none` when
    /// the search refused no tile at all.
    ///
    /// <para>
    /// `standability` says which of the search's two predicates spoke; this says what the world puts there. Measured
    /// `round81`: seven refusals carried `stand_at=none;in_reach=16;nearest=75,39;blocked_by=range:standability`, which
    /// names one tile out of sixteen and no reason for it - so the sentence could not be checked against the farm.
    /// </para>
    /// </summary>
    private static string DescribeStandRefusal(
        StardewValley.GameLocation location,
        Farmer actor,
        (int X, int Y) actorTile,
        (int X, int Y)? refusedTile) =>
        refusedTile is { } refused
            ? RefusalProbe.DescribeWorld(
                action: null,
                location,
                new Vector2(refused.X, refused.Y),
                new Vector2(actorTile.X, actorTile.Y),
                actor).Format()
            : "none";

    /// <summary>
    /// The movement pair a <c>pickup_item</c> success states about the drop it published, spelled once because the Mod
    /// reaches that success on two routes: the magnet's delivery seen when the request arrives (the chunk is already
    /// gone from the ground and the publication row proves the pack took it) and the same delivery seen on a later tick
    /// of the wait.
    ///
    /// <para>
    /// <paramref name="consumed"/> is measured from the PUBLISHED stack, never from the pack delta - the magnet also
    /// collects chunks of the same item this request never named, so <c>inventory_after - inventory_before</c> is not
    /// this drop's count. <paramref name="identityGone"/> is what lets the remainder be a number at all: <c>0</c> when
    /// no chunk of that identity is left in the location, <c>none</c> where a chunk of it is still on the ground and
    /// therefore the published stack need not be the stack that chunk holds.
    /// </para>
    /// </summary>
    private static string DescribeItemPickupMovement(int consumed, bool identityGone) =>
        $"object_consumed={consumed.ToString(CultureInfo.InvariantCulture)};object_after={(identityGone ? "0" : "none")}";

    private static string DescribeItemPickupReach(Farmer actor, Point chunkTile, Vector2 subject)
    {
        Point standing = actor.StandingPixel;
        Vector2 distance = MagneticPickupReach.AxisDistance(subject, standing);
        return $"actor_tile={(int)actor.Tile.X},{(int)actor.Tile.Y};chunk_tile={chunkTile.X},{chunkTile.Y};"
            + $"axis_distance_px={distance.X.ToString("0.#", CultureInfo.InvariantCulture)},{distance.Y.ToString("0.#", CultureInfo.InvariantCulture)};radius={MagneticPickupReach.ReachPixels(actor)}";
    }

    /// <summary>
    /// The magnet's delivery, settled when the request arrives after the engine already collected the chunk.
    ///
    /// <para>
    /// A receipt that says the item is gone has to prove it, and a receipt that says it was consumed has to name what
    /// consumed it. Both are answered here from two facts the caller has already established: <c>FindItemTarget</c>
    /// searched the WHOLE location by identity and found nothing (so no chunk of this drop is left on the ground - the
    /// <c>chunk_removed=true</c> below), and <see cref="GroundItemPublication.MagnetDeliveredIt"/> holds, so this
    /// actor's own count rose by at least the stack that was on the tile when the target was last published with the
    /// chunk still there (<c>native_auto_collect=true</c> names the engine's magnet as the collector). The movement pair
    /// is published from those same two facts, in the shape the wait's own settle uses - one success, one shape.
    /// </para>
    /// </summary>
    private LocalExecutionReceipt? TrySettleMagnetCollectedItem(
        string requestId,
        string executionId,
        Farmer boundActor,
        StardewValley.GameLocation location,
        string expectedTargetId,
        string expectedQualifiedItemId,
        int targetX,
        int targetY)
    {
        GroundItemPublication? publication = this.groundItemTargets.Recall(expectedTargetId);
        if (publication is null
            || publication.TileX != targetX
            || publication.TileY != targetY
            || !string.Equals(publication.Location, location.NameOrUniqueName, StringComparison.Ordinal)
            || !string.Equals(publication.QualifiedItemId, expectedQualifiedItemId, StringComparison.Ordinal))
            return null;
        int ageTicks = this.tick - publication.PublishedTick;
        if (ageTicks < 0 || ageTicks > ItemPickupMagnetClaimTicks)
            return null;

        int inventoryNow = CountQualifiedItem(boundActor, expectedQualifiedItemId);
        if (!publication.MagnetDeliveredIt(inventoryNow))
            return null;

        return this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "item_picked_up",
            $"location={publication.Location};target={expectedTargetId};tile={publication.TileX},{publication.TileY};item={expectedQualifiedItemId};stack={publication.Stack};{DescribeItemPickupMovement(publication.Stack, identityGone: true)};native_auto_collect=true;chunk_removed=true;inventory_before={publication.InventoryAtPublication};inventory_after={inventoryNow}");
    }

}

/// <summary>
/// One <c>pickup_forage</c> attempt's native facts, and the verdict plus sentence they settle on.
///
/// <para>
/// WHY THE ANTECEDENT IS PUBLISHED. <c>Game1.tryToCheckAt</c> is the engine's own click entry, and it is where a forage
/// is actually picked up; <c>removed</c> and <c>inventory_after</c> are only its CONSEQUENCES. Measured `round82`:
/// <c>pickup_forage</c> from `(56,13)` onto a daffodil at `(57,12)` arrived exactly and answered
/// <c>forage_postcondition_unavailable:removed=False;inventory_before=0;inventory_after=0</c> - which is true of a click
/// the engine declined, of a click that removed the object and delivered nothing, and of a pack that took the item and
/// lost it, and cannot tell them apart. <c>action_handled</c> is the fact that separates the first from the other two.
/// </para>
/// <para>
/// THE CONTAINER IS NAMED BECAUSE IT IS THE QUESTION A "removed=False" RECEIPT ASKS. Every fact here is read from
/// <c>location.objects</c>: it is the collection <c>DiscoverForageTargets</c> scans for this action's species AND the one
/// the engine's own forage branch removes the object from (<c>objects.Remove(vector)</c>, GameLocation.cs:7837, inside
/// the branch opened at :7791). A bush - the case that would make the container ambiguous - lives in
/// <c>largeTerrainFeatures</c> and is used through <c>performUseAction</c> (:7857-7867), which is <c>harvest_bush</c>'s
/// subject, never this action's; so this action has exactly one container and states it.
/// </para>
/// <para>
/// THE TWO GATES THE ACTION'S OWN PRECONDITIONS DO NOT ASK are published beside it (<c>spawned</c>, <c>object_type</c>),
/// because they are the engine's own answer to whether the forage branch runs at all: <c>value.isSpawnedObject.Value ||
/// isErrorItem</c> and <c>value.Type != null || isErrorItem</c> (GameLocation.cs:7791, :7727). An object that is a
/// forageable by <c>isForage()</c> and still fails either gate is one the click path silently refuses, and a receipt
/// that says so is the difference between "walk again" and "this will never be picked up".
/// </para>
/// <para>
/// WHICH GATE THE LIVE REFUSALS HIT, read out of the engine's own branch instead of guessed. The same daffodil answered
/// four refusals - `round66` twice, `round82` once, `round83` twice - always as <c>forage_80109cc4e46cdd7f</c> at Farm
/// `(57,12)`, always after a walk that reported `arrival=exact;stand_at=58,11|56,12` (one tile from the flower, inside
/// <c>Utility.tileWithinRadiusOfPlayer</c>), and never once removed. That is not a race and not the wrong container: the
/// play-session fixture writes the object with <c>farm.objects.Add(spot, new StardewValley.Object("18", 1))</c>
/// (ModEntry.Fixtures.cs:850), and that constructor sets <c>isSpawnedObject = false</c> (Object.cs:903) - only the
/// engine's own <c>dropObject</c> sets it (GameLocation.cs:13264), which is the path the two DEDICATED forage fixtures
/// use and assert (ModEntry.Fixtures.ScenarioInitializers.cs:480, :486; ModEntry.Fixtures.HostAutomation.PickupForage.cs:61
/// says so in as many words). So <c>:7791</c> is false, the whole <c>objects</c> block is skipped, <c>checkAction</c>
/// falls through terrain, large terrain and building actions and answers <c>return false</c> at :7940 on every attempt -
/// the numbers the four refusals published, forever. <c>blocked_by</c> names that gate so a reader can repair the
/// world instead of re-walking to it.
/// </para>
/// <para>
/// WHEN THE PAIR WAS READ, which the four refusals could not say either. <c>removed</c>/<c>inventory_after</c> are
/// sampled after <c>Game1.tryToCheckAt</c> returned, and for this action the engine's mutation happens inside that call
/// (GameLocation.cs:7830, :7837, :7838) - so the pair is
/// <see cref="PostconditionReadPoint.AfterTheSettle"/> and a "nothing changed" reading is a fact about the world rather
/// than a check that outran the engine. The sentence prints both the point and the call it settled after, because an
/// unqualified pair is what made a decline and a race indistinguishable for two rounds.
/// </para>
/// </summary>
internal readonly record struct ForagePickupPostcondition(
    bool ActionHandled,
    bool Removed,
    int InventoryBefore,
    int InventoryAfter,
    bool Spawned,
    string? ObjectType) : IReadsAWorldStateBeforeAndAfter
{
    /// <summary>
    /// The one container this action's facts come from - see the type's remarks for why it has exactly one.
    /// </summary>
    private const string Container = "location.objects";

    /// <summary>
    /// The call whose return the pair is read after: <c>Game1.tryToCheckAt</c> is the engine's click entry and the only
    /// mutation this action performs, so naming it is what turns "after the settle" into a checkable claim.
    /// </summary>
    private const string Settle = "game1.try_to_check_at";

    public string ActionId => ExecutionManager.ForagePickupActionId;

    public PostconditionReadPoint ReadPoint => PostconditionReadPoint.AfterTheSettle;

    /// <summary>
    /// Which of the engine's two gates on the object refuses it, in the order <c>GameLocation.checkAction</c> asks them
    /// (:7727 <c>value.Type != null || isErrorItem</c>, then :7791 <c>value.isSpawnedObject.Value || isErrorItem</c>), or
    /// <see langword="null"/> when both let it in.
    ///
    /// <para>
    /// `isErrorItem` is the third input of both gates and is not a field here, because the request half has already
    /// excluded it: an error item answers <c>isForage()</c> false (Object.cs:2806-2813 reads the category and the
    /// context tag, neither of which an item with no data row has) and is refused as
    /// <c>forage_target_unavailable</c> before this type is built.
    /// </para>
    /// </summary>
    internal string? EngineGate =>
        this.ObjectType is null ? "object_type_null"
        : !this.Spawned ? "not_a_spawned_object"
        : null;

    /// <summary>
    /// Succeeded only when the engine handled the click AND the object left its tile AND the pack gained exactly one of
    /// the named item. A click the engine DID handle without those consequences stays <see cref="ExecutionState.Uncertain"/>,
    /// because that is a world where the caller cannot tell whether the flower is still there; a click the engine never
    /// handled, on an object one of the branch's own gates refuses, is <see cref="ExecutionState.Rejected"/> - nothing
    /// happened, nothing CAN happen to that object, and the sentence names the gate to repair.
    /// </summary>
    internal ExecutionState State =>
        this.ActionHandled && this.Removed && this.InventoryAfter == this.InventoryBefore + 1
            ? ExecutionState.Succeeded
            : this.ActionHandled
                ? ExecutionState.Uncertain
                : this.EngineGate is not null
                    ? ExecutionState.Rejected
                    : ExecutionState.Uncertain;

    internal string ReasonCode => this.State switch
    {
        ExecutionState.Succeeded => "forage_picked_up",
        ExecutionState.Rejected => "forage_target_not_pickable",
        _ => "forage_postcondition_unavailable",
    };

    internal string Describe(string location, string targetId, int tileX, int tileY, string qualifiedItemId) =>
        $"location={location};targetIdentity={targetId};tile={tileX},{tileY};item={qualifiedItemId};container={Container};"
        + $"action_handled={this.ActionHandled.ToString().ToLowerInvariant()};blocked_by={this.GateToken.Format()}"
        + $";spawned={this.Spawned.ToString().ToLowerInvariant()};object_type={this.ObjectType ?? "none"}"
        + $";removed={this.Removed.ToString().ToLowerInvariant()};inventory_before={this.InventoryBefore};inventory_after={this.InventoryAfter}"
        + $";settle={Settle};read={this.ReadPoint.ToWireValue()}";

    /// <summary>The gate in the vocabulary every other refusal in this file uses, or <c>none</c>.</summary>
    private RefusalLayerToken GateToken =>
        this.EngineGate is { } gate
            ? new RefusalLayerToken(RefusalLayerKind.ObjectOnTile, gate)
            : RefusalLayerToken.None;
}
