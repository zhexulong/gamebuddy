using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Routing;
using Netcode;
using StardewValley;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// `a_refusal_for_a_thing_that_changes_nothing_gates_it_like_a_change:&lt;action&gt;`.
///
/// <para>
/// MEASURED `1795084502755`: a flat `face_direction` came back `actor_moving` because the companion was WALKING. The
/// request changes nothing in the world - `Character.faceDirection` writes the actor's own facing and asks nothing of her
/// - so the refusal gated a thing that changes nothing on a fact about the body, and named nothing the caller could wait
/// for. The same reading took `express_emote` out of the durability alarm
/// (<c>DurabilityAlarmScopeGateTests</c>); this gate holds the other half of it.
/// </para>
///
/// <para>
/// THE POPULATION IS THE CATALOGUE (derived from <see cref="FarmhandActionCatalog.ActionsThatChangeNothing"/>. The
/// keys, never a list here) and each member is DISPATCHED through the real router composition
/// (<see cref="ModEntry.CreateFarmhandActionRouter"/>) toward a body that is WALKING and owned by nobody, so the receipt
/// judged is the one the product mints. The census prints
/// <c>actions examined A · gated-on-body A1 · gated-on-world A2 · waiting-with-a-name W</c>: `A1` is the defect (a
/// refusal for a thing that changes nothing, gated on the body moving), `W` is its honest form (the same hold, waited
/// out and NAMED - `next_step=`, `admissible_actions=`, `retry_window_ms=`), and `A2` is counted apart because a world
/// condition the action cannot create (a lobby with nobody in it) is a fact about the world and not a body hold.
/// </para>
///
/// <para>
/// THE THREE ZEROES: a member whose native call the probe world cannot host is <c>not measured</c> and is named, never
/// silently passed - the probe supplies every NetField the admission dereferences, so a gap here is the double's and it
/// fails rather than reading as a green.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the refusals are produced by dispatching the real handlers through the real router, and the engine's absence of a movement precondition is read from the decompiled target-version tree, because the native call the Mod makes cannot be executed in a headless runner.
public sealed class RefusalForANonChangingActionGateTests
{
    private const string Gate = "a_refusal_for_a_thing_that_changes_nothing_gates_it_like_a_change";

    private readonly ITestOutputHelper output;

    public RefusalForANonChangingActionGateTests(ITestOutputHelper output) => this.output = output;

    /// <summary>
    /// THE GATE. Every action the catalogue declares changes nothing is dispatched with the body WALKING; none of them
    /// may be refused on that fact, and one that is must either wait with a name or fail HERE naming it.
    /// </summary>
    [Fact]
    public void EveryActionThatChangesNothingIsAppliedOrWaitsWithAName()
    {
        bool eventWasUp = Game1.eventUp;
        Game1.eventUp = false;
        try
        {
            var driven = new List<DrivenReceipt>();
            foreach (string actionId in FarmhandActionCatalog.ActionsThatChangeNothing.Keys.OrderBy(id => id, StringComparer.Ordinal))
                driven.Add(Drive(actionId));

            RefusalCensus census = Judge(driven);
            this.output.WriteLine(census.Line);
            foreach (DrivenReceipt receipt in driven)
                this.output.WriteLine($"  {receipt.ActionId} → {receipt.State}/{receipt.ReasonCode} · {receipt.Evidence}");

            census.Examined.Should().Be(
                FarmhandActionCatalog.ActionsThatChangeNothing.Count,
                "the population is the catalogue's own declaration, driven whole");
            census.Examined.Should().BeGreaterThan(0, "a gate whose population is empty agrees with itself");
            census.NotMeasured.Should().Be(
                0,
                $"{census.Line}: the probe supplies every NetField the admission reads, so an unreadable native call is the double's gap and not the product's");
            census.GatedOnBody.Should().Be(
                0,
                $"{census.Line}: {string.Join(" ", census.Findings)} - a refusal for a thing that changes nothing gates it like a change");
            (census.Applied + census.GatedOnBody + census.GatedOnWorld + census.Waiting + census.NotMeasured).Should().Be(
                census.Examined,
                "every action lands in exactly one arm, so none is silently outside the count");
            census.Applied.Should().BeGreaterThan(0, "the population is not empty and the body being walked is not a hold for it");
        }
        finally
        {
            Game1.eventUp = eventWasUp;
        }
    }

    /// <summary>
    /// THE FALSIFIER, on the measured shape: the exact receipt `1795084502755` produced is judged by the same function
    /// the gate uses, and is reported by name.
    /// </summary>
    [Fact]
    public void ABodyMotionRefusalForAFacingIsReportedByName()
    {
        RefusalCensus census = Judge(new[]
        {
            new DrivenReceipt("face_direction", ExecutionState.Rejected, "actor_moving", null),
        });

        census.Examined.Should().Be(1);
        census.GatedOnBody.Should().Be(1);
        census.Findings.Should().Equal($"{Gate}:face_direction");
        census.Line.Should().Contain("gated-on-body 1");
    }

    /// <summary>
    /// The honest form of the same hold: a refusal that WAITS and says what it waits for is counted as waiting and is
    /// not the defect - which is what keeps this gate from demanding that a bounded wait be deleted.
    /// </summary>
    [Fact]
    public void ARefusalThatWaitsWithANameIsCountedAsWaiting()
    {
        RefusalCensus census = Judge(new[]
        {
            new DrivenReceipt("express_emote", ExecutionState.Accepted, ExecutionManager.HeldRequestMarker,
                "held_by=transient_busy;retry_window_ms=2000;next_step=wait_for_retry_window"),
            new DrivenReceipt("face_direction", ExecutionState.Rejected, "body_owned_by_movement",
                "owner_execution_id=exec_01;owner_action=move_to_tile;interruptible=true"),
        });

        census.Waiting.Should().Be(1);
        census.GatedOnBody.Should().Be(1, "an ownership refusal that names no wait is still a body gate");
        census.Findings.Should().Equal($"{Gate}:face_direction");
    }

    /// <summary>
    /// A world condition the action cannot create - no lobby to speak into - is counted apart from a body hold, so the
    /// census cannot read a legitimate refusal as the defect this gate exists for.
    /// </summary>
    [Fact]
    public void AWorldConditionIsCountedApartFromABodyHold()
    {
        RefusalCensus census = Judge(new[]
        {
            new DrivenReceipt("send_multiplayer_chat", ExecutionState.Rejected, "chat_multiplayer_only", "role=none;multiplayer_mode=0"),
        });

        census.GatedOnWorld.Should().Be(1);
        census.GatedOnBody.Should().Be(0);
        census.Findings.Should().BeEmpty();
    }

    /// <summary>
    /// WHAT THE ENGINE DOES WITH THE READING. `Character.faceDirection` (Character.cs:713) writes the facing with no
    /// movement precondition at all, `Farmer.doEmote` (Farmer.cs:9046) arms an animation with no movement precondition
    /// either, and the walk re-asserts its own direction on every step - which is why the Mod applies the facing and
    /// publishes `moving=` rather than refusing.
    /// </summary>
    [Fact]
    public void TheEngineAppliesAFacingAndAnEmoteWithNoMovementPrecondition()
    {
        IReadOnlyList<string> character = DecompiledSource.Code(DecompiledSource.Lines("StardewValley/Character.cs"));
        IReadOnlyList<string> facing = DecompiledSource.MethodBody(character, "public virtual void faceDirection(int direction)");
        facing.Should().NotBeEmpty("the engine's own facing write has to still be there under this name");
        foreach (string precondition in new[] { "isMoving", "CanMove", "eventUp", "Halt" })
        {
            facing.Should().NotContain(
                line => line.Contains(precondition, StringComparison.Ordinal),
                $"`Character.faceDirection` asks nothing about movement, so a `{precondition}` test there is the precondition the Mod would be mirroring");
        }

        facing.Should().Contain(line => line.Contains("FacingDirection = direction", StringComparison.Ordinal));

        IReadOnlyList<string> farmer = DecompiledSource.Code(DecompiledSource.Lines("StardewValley/Farmer.cs"));
        IReadOnlyList<string> emote = DecompiledSource.MethodBody(farmer, "public void doEmote(int whichEmote)");
        emote.Should().NotBeEmpty("the emote the Mod dispatches has to still be there under this name");
        emote.Should().NotContain(
            line => line.Contains("isMoving", StringComparison.Ordinal),
            "the game's own emote is not gated on the body being still either");

        foreach (int direction in new[] { 0, 1, 2, 3 })
        {
            character.Should().Contain(
                line => line.Trim() == $"faceDirection({direction});",
                $"the movement loop faces the direction it steps, so the walk owns the facing until it stops - the fact `moving=` publishes");
        }
    }

    /// <summary>
    /// AND THE RECEIPT SAYS SO. The facing asked of a walking body is applied, and the sentence carries the fact that the
    /// walk will re-assert its own direction, so a caller reading it cannot mistake the effect for a durable one.
    /// </summary>
    [Fact]
    public void AFacingAskedOfAWalkingBodyIsAppliedAndSaysTheWalkOwnsTheNextStep()
    {
        (DrivenReceipt receipt, WalkingProbeFarmer actor) = DriveFacing("up");

        receipt.State.Should().Be(ExecutionState.Succeeded);
        receipt.ReasonCode.Should().Be("actor_facing_matches");
        receipt.Evidence.Should().Contain("moving=true", "the walk is the fact the caller has to plan around");
        actor.Faces.Should().ContainSingle("`up` is the engine's 0 and the native call reached the actor").Which.Should().Be(0);
    }

    // -------------------------------------------------------------------------
    // The drive: one real dispatch per population member, against a walking body.
    // -------------------------------------------------------------------------

    /// <summary>
    /// One catalogue action dispatched through the REAL router composition toward a body that reports it is walking.
    /// The request's arguments come from the action's own descriptor, so nothing here lists what an action takes.
    /// </summary>
    private static DrivenReceipt Drive(string actionId)
    {
        WalkingProbeFarmer actor = WalkingActor();
        ExecutionManager executions = Manager(actionId, actor);
        FarmhandActionRouter router = ModEntry.CreateFarmhandActionRouter(executions);
        BridgeExecutionRequest request = Request(actionId);
        bool routed = router.TryRoute(request, executions, out LocalExecutionReceipt receipt, out string reason);
        routed.Should().BeTrue($"{actionId}: {reason}");
        return new DrivenReceipt(actionId, receipt.State, receipt.ReasonCode, receipt.Evidence);
    }

    private static (DrivenReceipt Receipt, WalkingProbeFarmer Actor) DriveFacing(string direction)
    {
        WalkingProbeFarmer actor = WalkingActor();
        ExecutionManager executions = Manager("face_direction", actor);
        FarmhandActionRouter router = ModEntry.CreateFarmhandActionRouter(executions);
        BridgeExecutionRequest request = Request("face_direction") with { Args = new BridgeExecutionArgs { Direction = direction } };
        router.TryRoute(request, executions, out LocalExecutionReceipt receipt, out string reason).Should().BeTrue(reason);
        return (new DrivenReceipt("face_direction", receipt.State, receipt.ReasonCode, receipt.Evidence), actor);
    }

    private static ExecutionManager Manager(string actionId, Farmer actor)
    {
        FarmhandCapabilityPublication publication = FarmhandCapabilityPublication.Initial(
            new HashSet<string>(StringComparer.Ordinal) { actionId });
        var executions = new ExecutionManager(new DummyMonitor(), () => publication);
        executions.SetTestActorResolver(() => actor);
        return executions;
    }

    /// <summary>
    /// A probe farmer that says it is WALKING and records the native facing write. It supplies the NetFields the
    /// admission dereferences (<c>netStamina</c>, <c>usingTool</c>, the sprite), the same completeness
    /// <see cref="ProbeFarmerSprite"/> documents for every other probe farmer in this suite.
    /// </summary>
    private static WalkingProbeFarmer WalkingActor()
    {
        var actor = (WalkingProbeFarmer)FormatterServices.GetUninitializedObject(typeof(WalkingProbeFarmer));
        typeof(Farmer)
            .GetField("uniqueMultiplayerID", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(actor, new NetLong(1001));
        typeof(Farmer)
            .GetField("netStamina", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(actor, new NetFloat(270f));
        typeof(Farmer)
            .GetField("usingTool", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(actor, new NetBool(value: false));
        // `canMove` is an inline-initialised plain field (`Farmer.cs:690 public bool canMove = true`), so an uninitialised
        // probe reports a body that may not act - which the admission reads and refuses on.
        typeof(Farmer)
            .GetField("canMove", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(actor, true);
        ProbeFarmerSprite.Attach(actor);
        return actor;
    }

    /// <summary>The request shape the catalogue declares for one action, with a legal value per declared argument.</summary>
    private static BridgeExecutionRequest Request(string actionId)
    {
        IReadOnlyList<FarmhandActionArgument> declared = FarmhandActionCatalog.Registrations
            .Single(row => string.Equals(row.ActionId, actionId, StringComparison.Ordinal))
            .Descriptor?.Arguments ?? Array.Empty<FarmhandActionArgument>();
        bool declares(string name) => declared.Any(argument => string.Equals(argument.Name, name, StringComparison.Ordinal));
        return new BridgeExecutionRequest(
            $"req_refusal_gate_{actionId}",
            $"idem_refusal_gate_{actionId}",
            actionId,
            new BridgeExecutionArgs
            {
                Direction = declares("direction") ? FarmhandActionCatalog.DirectionEnum[0] : null,
                Emote = declares("emote") ? FarmhandActionCatalog.EmoteEnum[0] : null,
                Text = declares("text") ? "hello" : null,
            },
            ExpectedRevision: 0,
            DeadlineMs: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000);
    }

    // -------------------------------------------------------------------------
    // The judgement, fed its receipts so the honest ones and the injected ones share it.
    // -------------------------------------------------------------------------

    /// <summary>What one receipt says about the gate: applied, waiting with a name, or gated.</summary>
    internal enum RefusalKind
    {
        Applied,

        /// <summary>A body hold that names what it waits for - the honest form of the same fact.</summary>
        WaitingWithAName,

        /// <summary>Refused on a fact about the body, naming nothing to wait for: the defect.</summary>
        GatedOnBody,

        /// <summary>Refused on a world condition this action cannot create.</summary>
        GatedOnWorld,

        /// <summary>The probe could not host the call: not a product answer.</summary>
        NotMeasured,
    }

    /// <summary>One dispatch's answer, as the census reads it.</summary>
    internal readonly record struct DrivenReceipt(string ActionId, ExecutionState State, string ReasonCode, string? Evidence);

    /// <summary>The census, with its own line so every failure message carries the population it was read over.</summary>
    internal readonly record struct RefusalCensus(
        int Examined,
        int Applied,
        int GatedOnBody,
        int GatedOnWorld,
        int Waiting,
        int NotMeasured,
        IReadOnlyList<string> Findings)
    {
        internal string Line =>
            $"actions examined {this.Examined} · gated-on-body {this.GatedOnBody} · gated-on-world {this.GatedOnWorld}"
            + $" · waiting-with-a-name {this.Waiting}";
    }

    internal static RefusalCensus Judge(IReadOnlyList<DrivenReceipt> receipts)
    {
        var findings = new List<string>();
        int applied = 0;
        int waiting = 0;
        int gatedOnBody = 0;
        int gatedOnWorld = 0;
        int notMeasured = 0;
        foreach (DrivenReceipt receipt in receipts)
        {
            switch (Classify(receipt))
            {
                case RefusalKind.Applied:
                    applied += 1;
                    break;
                case RefusalKind.WaitingWithAName:
                    waiting += 1;
                    break;
                case RefusalKind.GatedOnBody:
                    gatedOnBody += 1;
                    findings.Add($"{Gate}:{receipt.ActionId}");
                    break;
                case RefusalKind.GatedOnWorld:
                    gatedOnWorld += 1;
                    break;
                default:
                    notMeasured += 1;
                    findings.Add($"{Gate}:{receipt.ActionId}:not_measured:{receipt.ReasonCode}");
                    break;
            }
        }

        return new RefusalCensus(receipts.Count, applied, gatedOnBody, gatedOnWorld, waiting, notMeasured, findings);
    }

    /// <summary>
    /// Which arm one receipt lands in. A WAIT is decided first and narrowly: an evidence sentence that names a step, an
    /// admissible family or a retry window is the caller being TOLD what to do, which is the honest form of a hold - and
    /// it is only looked for on a receipt that did not succeed, so an applied expression is never counted as waiting.
    /// </summary>
    internal static RefusalKind Classify(DrivenReceipt receipt)
    {
        if (string.Equals(receipt.ReasonCode, ExecutionManager.HeldRequestMarker, StringComparison.Ordinal))
            return RefusalKind.WaitingWithAName;

        if (receipt.State is ExecutionState.Succeeded or ExecutionState.Accepted or ExecutionState.Running
            or ExecutionState.PartiallySucceeded or ExecutionState.MeaningfulProgress)
            return RefusalKind.Applied;

        if (NamesAWait(receipt.Evidence))
            return RefusalKind.WaitingWithAName;

        if (IsABodyFact(receipt.ReasonCode))
            return RefusalKind.GatedOnBody;

        if (receipt.State is ExecutionState.Uncertain or ExecutionState.Failed
            && (receipt.ReasonCode.EndsWith("_exception", StringComparison.Ordinal)
                || receipt.ReasonCode.EndsWith("_unavailable", StringComparison.Ordinal)))
            return RefusalKind.NotMeasured;

        return RefusalKind.GatedOnWorld;
    }

    /// <summary>
    /// Whether one evidence sentence tells the caller what to wait for, in the words the hold vocabulary publishes.
    /// `held_awaiting_actionability` is the Mod's own park, which is a wait with a window even before a step is named.
    /// </summary>
    private static bool NamesAWait(string? evidence) =>
        evidence is not null
        && (evidence.Contains("next_step=", StringComparison.Ordinal)
            || evidence.Contains("admissible_actions=", StringComparison.Ordinal)
            || evidence.Contains("retry_window_ms=", StringComparison.Ordinal)
            || evidence.Contains(ExecutionManager.HeldRequestMarker, StringComparison.Ordinal));

    /// <summary>
    /// Every reason code this Mod mints for a fact about the BODY: the closed hold vocabulary
    /// (<see cref="WorldModel.HoldReasonCode"/>, read from the enum rather than re-spelled) plus the ownership codes,
    /// which are consts on <see cref="ExecutionManager"/> whose names start `BodyOwned`. `actor_moving` is the code the
    /// flat facing used to mint and is named here so a re-introduction is caught rather than silently reclassified.
    /// </summary>
    private static readonly HashSet<string> BodyFactCodes = new(
        Enum.GetValues<ActorDispositionKind>()
            .Select(WorldModel.HoldReasonCode)
            .Concat(typeof(ExecutionManager)
                .GetFields(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)
                .Where(field => field.IsLiteral && field.Name.StartsWith("BodyOwned", StringComparison.Ordinal))
                .Select(field => (string)field.GetRawConstantValue()!))
            .Concat(new[] { "actor_moving", ExecutionManager.HeldRequestMarker }),
        StringComparer.Ordinal);

    private static bool IsABodyFact(string reasonCode) => BodyFactCodes.Contains(reasonCode);

    /// <summary>
    /// A probe body that says it is walking and records the native facing write, so the two facts the action reads are
    /// the two facts the game reports. It stands in for the engine BOUNDARY (which a headless runner cannot animate) and
    /// not for the Mod's own code: everything the receipt says is produced by the product.
    /// </summary>
    private sealed class WalkingProbeFarmer : Farmer
    {
        private int facing = 2;

        private List<int>? faces;

        /// <summary>Lazily created because an uninitialised probe skips field initialisers.</summary>
        internal List<int> Faces => this.faces ??= new List<int>();

        public override bool isMoving() => true;

        public override int FacingDirection { get => this.facing; set => this.facing = value; }

        public override void faceDirection(int direction)
        {
            this.facing = direction;
            this.Faces.Add(direction);
        }
    }
}
