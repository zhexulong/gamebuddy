using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Diagnostics;
using GameBuddy.Stardew.Core.Policy;
using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew;

internal sealed partial class ExecutionManager
{
    private readonly record struct TileTargetRefusal(string ReasonCode, string? Evidence);

    /// <summary>
    /// What one action's own gate answers about the target it was asked for: the tile the actor must be able to reach to
    /// act on it, or the refusal the action owes when that target is not there to act on.
    ///
    /// <para>
    /// WHICH TILE IS THE GATE'S ANSWER, NOT THE REQUEST'S, and that is the one fact that separates the two shapes this
    /// seam serves. A target that stands where the caller said it stands - a machine, a bush, a fence gate - is addressed
    /// by the request's own <c>x, y</c>, so its gate answers with that same tile. A subject that WALKS - a Pet, a
    /// FarmAnimal, a villager - is addressed by its opaque id and stands wherever it stands on the game thread NOW, so
    /// only the lookup knows the tile, and the tile a snapshot published is where the subject used to be.
    /// </para>
    ///
    /// <para>
    /// A refusal carries no tile (<see cref="Refused"/> writes none, and the seam returns the refusal before it reads
    /// one) because there is nothing to walk to: the target is gone or cannot be acted on, which is a different answer
    /// from "walk closer".
    /// </para>
    ///
    /// <para>
    /// A SETTLEMENT (<see cref="Settled"/>) is the third answer, and it is neither of those: the target is not there to
    /// act on BECAUSE the state the request asked for already holds. A rock the plan meant to break but an earlier
    /// settlement already broke, a modal that is already closed - the question "is it in the state I wanted" is
    /// answered yes, and refusing it costs the caller a turn to re-observe a world that already agrees with it. Measured
    /// `round77`: seven `break_rock` nodes of `plan_619` named the seven tiles `plan_562` had broken nine seconds
    /// earlier, and one more named tile `34,9`, broken four facts before it; all eight were refused and all eight were
    /// already done. The gate mints the terminal because it is the only half that can read the live world, and the seam
    /// mints no walk to a tile there is nothing left to do on.
    /// </para>
    ///
    /// <para>
    /// AN ABSENCE IS NOT THE EVIDENCE FOR ITSELF. "The thing is not there" is a success only when something says the
    /// action is what took it away, or that the engine's own finished state is the one the request asked for - so
    /// <see cref="Settled"/> takes the warrant in <see cref="TileTargetSettledBy"/> and prints it in the receipt.
    /// </para>
    /// </summary>
    /// <param name="Footprint">
    /// Every tile the resolved target occupies, when its gate knows them. `<see cref="X"/>, <see cref="Y"/>` stays the
    /// anchor the action's own reach predicate is asked about, so a multi-tile subject answers both questions and the
    /// approach leg can stand beside the face it can work. Null means the target is the one tile the anchor names.
    /// </param>
    private readonly record struct TileTargetGate(
        int X,
        int Y,
        TileTargetRefusal? Refusal,
        TileTargetSettlement? Settlement = null,
        (int X, int Y)[]? Footprint = null)
    {
        /// <summary>The target resolved: the actor must reach this tile to act on it.</summary>
        internal static TileTargetGate Resolved(int x, int y) => new(x, y, null);

        /// <summary>
        /// The target resolved as a piece covering <paramref name="footprint"/> tiles, of which <paramref name="x"/>,
        /// <paramref name="y"/> is the anchor.
        /// </summary>
        internal static TileTargetGate Resolved(int x, int y, (int X, int Y)[] footprint) => new(x, y, null, null, footprint);

        /// <summary>The target cannot be acted on: this is the refusal the action owes, and no tile is walked to.</summary>
        internal static TileTargetGate Refused(TileTargetRefusal refusal) => new(0, 0, refusal);

        /// <summary>
        /// The target is already in the state the request asked for: this terminal, no refusal and no walk, and the
        /// evidence carries the warrant <paramref name="settledBy"/> that says what makes it one.
        /// </summary>
        internal static TileTargetGate Settled(ExecutionState state, string reasonCode, string evidence, string settledBy) =>
            new(0, 0, null, new TileTargetSettlement(state, reasonCode, $"{evidence};{TileTargetSettledBy.EvidenceField}{settledBy}"));

        /// <summary>
        /// The target is already in the state the request asked for WHEN the catalogue says this action's success takes
        /// the addressed row out of the world, and <paramref name="otherwise"/> when it does not.
        ///
        /// <para>
        /// THE DECLARATION IS ASKED HERE, not at each site, so a `consumes` settlement cannot be minted without one:
        /// <see cref="TileTargetSettledBy.ConsumesFor"/> reads the action's own <see cref="FarmhandChoreDeclaration"/> and
        /// answers nothing when the declaration does not back the claim, in which case the world that does not hold the
        /// target is answered with the refusal the branch already owes. The action id is the site's own wire identity,
        /// spelled once at the call, and it is what the gate reads to hold the site against that declaration.
        /// </para>
        /// </summary>
        internal static TileTargetGate SettledIfConsumed(
            string actionId,
            ExecutionState state,
            string reasonCode,
            string evidence,
            TileTargetRefusal otherwise) =>
            TileTargetSettledBy.ConsumesFor(actionId) is { } warrant
                ? Settled(state, reasonCode, evidence, warrant)
                : new(0, 0, otherwise);
    }

    /// <summary>One gate's answer that the request's own outcome already holds, ready to be minted as the terminal.</summary>
    private readonly record struct TileTargetSettlement(ExecutionState State, string ReasonCode, string Evidence);

    /// <summary>
    /// THE IDENTITY THE TILE HOLDS NOW, for a request that named none.
    ///
    /// <para>
    /// A caller that sent <c>expectedTargetId</c> never asks this: the request names an identity and is answered exactly as
    /// it always was. A caller that sent none - which the action's own row permits
    /// (<see cref="FarmhandActionArgument.ResolvedAtExecution"/>) - is answered by the LIVE tile, minted by the family that
    /// row declares (<see cref="FarmhandActionCatalog.TargetFamilyOf"/>, so no handler restates it). That is what lets a
    /// clearing node name its target when she swings rather than when she read.
    /// </para>
    ///
    /// <para>
    /// RESOLVED ONCE PER REQUEST, at the gate, before the walk - and the caller writes it back into the seam's own
    /// <c>expectedTargetId</c>, so the approach leg, the executed body and the receipt all name ONE identity. A target minted
    /// twice in one request is two targets, and a request that mints on arrival has named different things at its two ends.
    /// </para>
    /// </summary>
    /// <returns>Whether the tile named a target; when it did not, <paramref name="refusal"/> is the answer owed.</returns>
    private static bool TryMintTileTargetAtExecution(
        string actionId,
        GameLocation location,
        int x,
        int y,
        out string targetId,
        out TileTargetRefusal refusal)
    {
        TileTargetMintResolution mint = TileTargetMint.AtExecution(location, x, y, FarmhandActionCatalog.TargetFamilyOf(actionId) ?? string.Empty);
        if (mint.Resolved)
        {
            targetId = mint.TargetId!;
            refusal = default;
            return true;
        }
        targetId = string.Empty;
        refusal = DescribeTileTargetMintRefusal(actionId, x, y, mint);
        return false;
    }

    /// <summary>
    /// The refusal a resolve-at-execution request is owed, in the ONE code whose shape says which of the three facts stopped
    /// it: nothing is there, something else is there, or the right thing is there and the action's own admission withheld it.
    ///
    /// <para>
    /// THREE CODES BECAUSE THEY ARE THREE REPAIRS. `*_target_absent` sends the caller to look elsewhere, `*_target_changed`
    /// sends it to re-observe a tile that moved under it, and `*_target_not_ready` sends it to wait for a tree to grow or a
    /// crop to ripen - and the last one carries the clause the admission itself published, so a tapped tree says
    /// `already_tapped` rather than "changed". What the tile carries is named in the SAME vocabulary a `for_each` row
    /// publishes as `occupant` (<see cref="TileOccupantKind"/>), and what the action removes is joined from its own
    /// <c>Clears</c> declaration, so neither side is a second list beside the catalogue.
    /// </para>
    /// </summary>
    private static TileTargetRefusal DescribeTileTargetMintRefusal(string actionId, int x, int y, TileTargetMintResolution mint)
    {
        string expected = DeclaredOccupants(actionId);
        return mint.Answer switch
        {
            TileTargetMintAnswer.Nothing => new TileTargetRefusal(
                $"{actionId}_target_absent",
                $"named_tile={x},{y};expected={expected};occupant={mint.OccupantKind}"),
            TileTargetMintAnswer.OtherKind => new TileTargetRefusal(
                $"{actionId}_target_changed:{expected}:{mint.OccupantKind}",
                $"named_tile={x},{y};expected={expected};found={mint.OccupantKind}"),
            _ => new TileTargetRefusal(
                $"{actionId}_target_not_ready:{mint.OccupantKind}:{mint.Clause ?? TileTargetRefusalClause.TargetIdUnresolved}",
                $"named_tile={x},{y};expected={expected};found={mint.OccupantKind};{TileTargetRefusalClause.Field}{mint.Clause ?? TileTargetRefusalClause.TargetIdUnresolved}"),
        };
    }

    /// <summary>
    /// The occupants the action's own <c>Clears</c> declaration names, joined for one code token: a single-occupant action
    /// reads <c>weed</c> and a clump action reads its nine, so a refusal never restates a list the catalogue already holds.
    /// </summary>
    private static string DeclaredOccupants(string actionId) =>
        FarmhandActionCatalog.ClearsOf(actionId) is { Occupants.Count: > 0 } clears
            ? string.Join("+", clears.Occupants)
            : TileOccupantKind.None;

    private LocalExecutionReceipt RequestLocalTileTarget(
        string actionId,
        string requestId,
        string expectedTargetId,
        long requestedDeadlineMs,
        AdmissionActionabilityProfile profile,
        Func<GameLocation, TileTargetGate> gate,
        Func<string, string, LocalExecutionReceipt> execute,
        Func<TileTargetRefusal?>? authorize,
        Func<Farmer, int, int, bool>? inReach = null)
    {
        if (this.BeginLocalExecution(requestId, out string executionId, out long nowMs) is LocalExecutionReceipt replay)
            return replay;
        if (authorize?.Invoke() is TileTargetRefusal unauthorized)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, unauthorized.ReasonCode, unauthorized.Evidence);
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, profile) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;
        GameLocation location = Game1.player.currentLocation;
        TileTargetGate answer = gate(location);
        if (answer.Settlement is not null || answer.Refusal is not null)
            return this.RememberTileTargetAnswer(requestId, executionId, answer);
        // TWO REASONS TO WALK, and only one of them is a radius. The action's own reach says she is too far from the tile;
        // the ring its row declares says she is beside it on a tile it cannot be worked from - a diagonal for a swing that
        // must be faced and for every charged tool use (`sweep_needs_cardinal_stance`, `charge_needs_cardinal_stance`,
        // both of which arrived AFTER a walk in `round92`). Both are read from the catalogue, so no request half has to
        // restate the geometry its own row already states.
        if (!(inReach ?? IsTileWithinNativeReach)(Game1.player, answer.X, answer.Y)
            || StandsOutsideADeclaredRing(actionId, Game1.player, answer.X, answer.Y))
        {
            // THE APPROACH LEG IS WHERE A TOOL ACTION'S GAME-THREAD TIME GOES, so it is measured here: planning a walk
            // floods the actor's walkable component to choose a standing tile and then asks the body controller for a
            // route, which floods again. Each flood reports its own tile count and milliseconds to the same line.
            using GameThreadCost.SeamScope approach = new(GameThreadCost.ApproachSeam);
            return this.TryBeginToolApproach(requestId, executionId, actionId, location, (answer.X, answer.Y), answer.Footprint ?? new[] { (answer.X, answer.Y) }, expectedTargetId, execute, nowMs, requestedDeadlineMs);
        }
        return execute(executionId, requestId);
    }

    /// <summary>
    /// Publishes one gate's own answer as the terminal: the settlement it carries, or the refusal it owes.
    ///
    /// <para>
    /// ONE SPELLING FOR BOTH PATHS THAT ASK A GATE. The seam asks it before the walk and the execution body asks it
    /// again after one, because an admitted request can wait through a walk while the world moves - so a settlement
    /// minted on the second read has to carry the same evidence and the same warrant as one minted on the first, and a
    /// branch that spelled its own `RememberTerminal` would drift from the gate it claims to repeat.
    /// </para>
    /// </summary>
    private LocalExecutionReceipt RememberTileTargetAnswer(string requestId, string executionId, TileTargetGate answer) =>
        answer.Settlement is TileTargetSettlement settled
            ? this.RememberTerminal(requestId, executionId, settled.State, settled.ReasonCode, settled.Evidence)
            : this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, answer.Refusal!.Value.ReasonCode, answer.Refusal!.Value.Evidence);

    private LocalExecutionReceipt RequestLocalTileTarget(
        string actionId,
        string requestId,
        string expectedTargetId,
        long requestedDeadlineMs,
        AdmissionActionabilityProfile profile,
        Func<GameLocation, TileTargetGate> gate,
        Func<string, string, LocalExecutionReceipt> execute) =>
        this.RequestLocalTileTarget(actionId, requestId, expectedTargetId, requestedDeadlineMs, profile, gate, execute, this.AuthorizeActorOnReadyWorld);

    private LocalExecutionReceipt RequestLocalTileTarget(
        string actionId,
        string requestId,
        int targetX,
        int targetY,
        string expectedTargetId,
        long requestedDeadlineMs,
        AdmissionActionabilityProfile profile,
        Func<GameLocation, TileTargetRefusal?>? gate,
        Func<Farmer, int, int, bool> inReach,
        Func<string, string, LocalExecutionReceipt> execute,
        Func<TileTargetRefusal?>? authorize = null) =>
        this.RequestLocalTileTarget(
            actionId,
            requestId,
            expectedTargetId,
            requestedDeadlineMs,
            profile,
            location => gate?.Invoke(location) is TileTargetRefusal refusal
                ? TileTargetGate.Refused(refusal)
                : TileTargetGate.Resolved(targetX, targetY),
            execute,
            authorize,
            inReach);

    private TileTargetRefusal? AuthorizeActorOnReadyWorld()
    {
        if (!this.TryGetBoundActor(out Farmer? boundActor, out string scopeReason) || boundActor is null)
            return new TileTargetRefusal(scopeReason, null);
        return Context.IsWorldReady && Game1.player is not null && Game1.player.currentLocation is not null
            ? null
            : new TileTargetRefusal("world_not_ready", null);
    }

    private TileTargetRefusal? AuthorizeActorOnFarmstead()
    {
        if (!this.TryGetBoundActor(out Farmer? boundActor, out string scopeReason) || boundActor is null)
            return new TileTargetRefusal(scopeReason, null);
        return Context.IsWorldReady && Game1.player is not null && Game1.player.currentLocation is Farm
            ? null
            : new TileTargetRefusal("farm_required", $"location={(Game1.player?.currentLocation?.NameOrUniqueName ?? "none")}");
    }

    private static bool IsTileWithinNativeReach(Farmer actor, int x, int y) => IsTileWithinChebyshevRadius(actor, x, y, 1);
}

/// <summary>
/// The forms a settlement's evidence may use to say WHAT MAKES IT ONE, and the one field it prints them in.
///
/// <para>
/// WHY THIS EXISTS. "The target is not there" is a success only when something says the request's own outcome already
/// holds - otherwise the absence is being used as the evidence for itself, and a real missing precondition (a machine
/// that was never in this room, a piece of furniture that never stood here) would be reported as work done. The design
/// admits exactly three sources: the catalogue declaring that this action's success takes the addressed row out of the
/// world (<see cref="FarmhandChoreDeclaration.Consumes"/>), the engine's own finished state, and a terminal already
/// recorded for the same action and subject
/// (<c>design/domains/stardew/action-execution-standardization.md</c>, L2).
/// </para>
///
/// <para>
/// TWO FORMS HAVE A PRODUCER TODAY, and that is a measurement rather than a gap. <c>break_rock</c>, <c>chop_tree</c> and
/// <c>cut_weeds</c> address a row their own success takes out of the world, so each prints <see cref="Consumes"/> and the
/// family its declaration names; <c>till_soil</c> addresses a row the ENGINE already reports in the asked-for state (its
/// postcondition IS <c>GetHoeDirtAtTile</c> non-null) and declares no chore, so it prints the engine's own flag. The third
/// is spelled here so the day a site mints one it uses this vocabulary instead of inventing a token a gate would have to
/// be taught; no producer exists for it, and none is written ahead of the site that needs it.
/// </para>
/// </summary>
internal static class TileTargetSettledBy
{
    /// <summary>
    /// The catalogue's own claim: this action's success takes the addressed row out of the world, so a world that no
    /// longer holds it is the state the request asked for.
    /// </summary>
    internal const string Consumes = "consumes";

    /// <summary>
    /// The engine's own completion state - a machine's <c>heldObject</c> empty, a gate's <c>gatePosition</c> at the
    /// requested value, a menu closed - printed as <c>engine_flag:&lt;field&gt;=&lt;value&gt;</c>.
    /// </summary>
    internal const string EngineFlagPrefix = "engine_flag:";

    /// <summary>
    /// A terminal already recorded for the same action and subject, printed as <c>prior_receipt:&lt;requestId&gt;</c>.
    /// </summary>
    internal const string PriorReceiptPrefix = "prior_receipt:";

    /// <summary>
    /// The catalogue's own claim about ONE action, printed as <c>consumes:&lt;family&gt;</c>, or null when the catalogue
    /// does not declare that this action's success consumes the row it addressed.
    ///
    /// <para>
    /// ASK THE DECLARATION FIRST. A site that settles on this form mints it from here rather than deciding for itself that
    /// an absence is its outcome, and the family is read from the action's own <see cref="FarmhandChoreDeclaration"/>
    /// (<c>FarmhandActionCatalog.ChoreFamilyOf</c>) instead of being restated beside it. When this answers nothing there
    /// is no warrant to print and the site must refuse: a settlement minted without one is the absence being used as the
    /// evidence for itself.
    /// </para>
    /// </summary>
    internal static string? ConsumesFor(string actionId) =>
        FarmhandActionCatalog.ChoreFamilyOf(actionId) is { } family ? $"{Consumes}:{family}" : null;

    /// <summary>
    /// The engine's own completion state, printed as <c>engine_flag:&lt;field&gt;=&lt;value&gt;</c> - the form for an action
    /// whose finished state the world itself reports and whose catalogue row declares no chore (<c>till_soil</c>, whose
    /// postcondition is the engine's own <c>GetHoeDirtAtTile</c> read).
    /// </summary>
    internal static string EngineFlag(string field, string value) => $"{EngineFlagPrefix}{field}={value}";

    /// <summary>The evidence field a settlement writes the warrant under, so the receipt and the gates spell it once.</summary>
    internal const string EvidenceField = "settled_by=";
}
